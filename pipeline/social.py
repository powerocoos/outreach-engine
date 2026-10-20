"""Turn new blog posts from the Squarespace RSS feed into Facebook + Instagram drafts.

Usage:
    python social.py                 # fetch feed, draft new posts with Claude, send them to <DASHBOARD_URL>/social
    python social.py --dry-run       # print the drafts instead of sending them
    python social.py --feed-file f.xml --dry-run   # use a saved feed (no network for the feed)

Posts already on the dashboard are skipped (so Claude is not paid twice), and only posts from the last
SOCIAL_MAX_AGE_DAYS (default 21) are picked up, so the first run does not backfill years of old posts.
You approve, edit and publish at <DASHBOARD_URL>/social.
"""
import argparse
import html
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlencode, urlparse, urlunparse, parse_qsl

import brand
import social_image
from common import http_request, require_env

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
FEED_URL = os.environ.get("SOCIAL_FEED_URL", "https://www.ocooswebconsulting.com/updates?format=rss")
MAX_AGE_DAYS = int(os.environ.get("SOCIAL_MAX_AGE_DAYS", "21"))
MAX_PER_RUN = int(os.environ.get("SOCIAL_MAX_PER_RUN", "3"))
FB_WORDS = (25, 110)
IG_WORDS = (30, 130)
LOGO_URL = os.environ.get("SOCIAL_LOGO_URL", "https://images.squarespace-cdn.com/content/v1/5dc50cc1afeeeb552425247c/d8489d11-b4c0-4699-abf0-75e870088b4f/Ocoos+Web+Consulting+Logo+01+-+smaller-min.png?format=500w")
NS = {"content": "http://purl.org/rss/1.0/modules/content/", "media": "http://www.rssboard.org/media-rss"}

SYSTEM_PROMPT = f"""You write social media posts for {brand.BRAND_NAME}, a web design agency serving {brand.SERVICE_AREA}.
You receive one new blog post (title, summary, section headings, an excerpt of the text, categories).
Write a Facebook post and an Instagram caption that make a local business owner want to read it.

Hard rules:
- Use ONLY facts that appear in the blog post you were given. Never invent statistics, prices, results,
  clients, awards, or promises. If you cite a number, it must appear in the post text.
- Plain, friendly, specific. No hype, no "game-changer", no clickbait, no all-caps shouting.
- Facebook: {FB_WORDS[0]}-{FB_WORDS[1]} words. Open with a concrete hook from the post (a problem, a surprising point, or a
  question). Add 2-4 short takeaways from the post if it helps. End with a soft call to read the full post.
  Do NOT put a URL in the text; the link is attached separately. At most 1 emoji. No hashtags.
- Instagram: {IG_WORDS[0]}-{IG_WORDS[1]} words, same facts, a bit more casual, line breaks between ideas. No URL. End the caption body
  with "Link in bio." Then a blank line and 5-8 relevant hashtags, mixing topic tags and local tags
  (for example #OcalaFlorida #NorthCentralFlorida #SmallBusiness). At most 2 emoji.
- Never include a phone number or email address.
- Do not claim services beyond: {brand.SERVICES}.

Return ONLY JSON: {{"facebook": str, "instagram": str}}"""


# ---- feed ------------------------------------------------------------------------
def strip_tags(markup):
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", markup or "", flags=re.S | re.I)
    text = re.sub(r"</(p|li|h[1-6]|div|tr)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"[ \t\r\f\v]+", " ", re.sub(r"\n\s*\n+", "\n", text)).strip()


def parse_feed(xml_text):
    """Return a list of dicts: title, link, pub_date (aware datetime), categories, summary, headings, text, image."""
    root = ET.fromstring(xml_text)
    posts = []
    for item in root.iter("item"):
        link = (item.findtext("link") or "").strip()
        title = html.unescape((item.findtext("title") or "").strip())
        if not link or not title:
            continue
        try:
            when = parsedate_to_datetime(item.findtext("pubDate"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            when = None
        body_html = item.findtext("content:encoded", namespaces=NS) or ""
        summary = strip_tags(item.findtext("description") or "")
        if len(summary) > 400:  # older posts put the whole article in <description>
            summary = summary[:400].rsplit(" ", 1)[0] + "..."
        media = item.find("media:content", NS)
        posts.append({
            "title": title,
            "link": link,
            "pub_date": when,
            "categories": [c.text.strip() for c in item.findall("category") if c.text],
            "summary": summary,
            "headings": [strip_tags(h) for h in re.findall(r"<h[23][^>]*>(.*?)</h[23]>", body_html, flags=re.S | re.I)][:12],
            "text": strip_tags(body_html or item.findtext("description") or "")[:3500],
            "image": media.get("url") if media is not None else None,
        })
    return posts


def tag_link(url, source="facebook", medium="social", campaign="blog-share"):
    parts = urlparse(url)
    query = dict(parse_qsl(parts.query))
    query.update({"utm_source": source, "utm_medium": medium, "utm_campaign": campaign})
    return urlunparse(parts._replace(query=urlencode(query)))


def fresh(posts, known, now=None, max_age_days=MAX_AGE_DAYS, limit=MAX_PER_RUN):
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=max_age_days)
    out = [p for p in posts if p["link"] not in known and p["pub_date"] and p["pub_date"] >= cutoff]
    out.sort(key=lambda p: p["pub_date"], reverse=True)
    # Keep the newest few, then queue oldest first so the newest ends up on top in the dashboard.
    return list(reversed(out[:limit]))


# ---- drafting --------------------------------------------------------------------
def words(text):
    return len(text.split())


def validate(draft, post):
    """Return a list of problems; empty means the draft passes."""
    problems = []
    fb, ig = draft.get("facebook"), draft.get("instagram")
    if not isinstance(fb, str) or not fb.strip() or not isinstance(ig, str) or not ig.strip():
        return ["missing facebook or instagram text"]
    ig_body = ig.split("#", 1)[0]
    if not FB_WORDS[0] <= words(fb) <= FB_WORDS[1]:
        problems.append(f"facebook is {words(fb)} words")
    if not IG_WORDS[0] <= words(ig_body) <= IG_WORDS[1]:
        problems.append(f"instagram is {words(ig_body)} words")
    for name, t in (("facebook", fb), ("instagram", ig)):
        if re.search(r"https?://|www\.", t, re.I):
            problems.append(f"{name} contains a URL")
        if re.search(r"\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}", t) or re.search(r"\S+@\S+\.\S+", t):
            problems.append(f"{name} contains a phone number or email")
    if "#" in fb:
        problems.append("facebook has hashtags")
    tags = re.findall(r"#\w+", ig)
    if not 3 <= len(tags) <= 10:
        problems.append(f"instagram has {len(tags)} hashtags")
    if "link in bio" not in ig.lower():
        problems.append("instagram is missing 'Link in bio'")
    # Every number the model writes must come from the post, so nothing is made up.
    source = " ".join([post["title"], post["summary"], post["text"], " ".join(post["headings"])])
    source_nums = set(re.findall(r"\d[\d,.]*", source))
    for num in set(re.findall(r"\d[\d,.]*", fb + " " + ig_body)):
        if num.rstrip(".,") not in {s.rstrip(".,") for s in source_nums}:
            problems.append(f"number {num} is not in the blog post")
    return problems


def template_draft(post):
    """Deterministic fallback: still a sensible post, never invents anything."""
    lead = post["summary"] or post["title"]
    tags = "#OcalaFlorida #NorthCentralFlorida #SmallBusiness #WebDesign #LocalBusiness"
    fb = f"New on our blog: {post['title']}.\n\n{lead}\n\nRead the full post to see what it means for your business."
    ig = f"New on the blog: {post['title']}.\n\n{lead}\n\nLink in bio.\n\n{tags}"
    return {"facebook": fb, "instagram": ig}


def claude_draft(post, api_key):
    payload = {k: post[k] for k in ("title", "summary", "headings", "text", "categories")}
    status, _, _, raw = http_request(
        "https://api.anthropic.com/v1/messages", method="POST", timeout=60,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        body={"model": MODEL, "max_tokens": 2000, "system": SYSTEM_PROMPT,
              "messages": [{"role": "user", "content": json.dumps(payload)}]},
    )
    if status != 200:
        raise RuntimeError(f"Anthropic API {status}: {raw[:200].decode('utf-8', 'ignore')}")
    text = "".join(b.get("text", "") for b in json.loads(raw).get("content", []) if b.get("type") == "text")
    if "{" not in text:
        raise RuntimeError("Claude returned no JSON")
    return json.loads(text[text.find("{"): text.rfind("}") + 1])


def make_draft(post, api_key, drafter=claude_draft):
    """Claude first (two tries), then the template. Returns (draft, how)."""
    if api_key:
        for _ in range(2):
            try:
                d = drafter(post, api_key)
                problems = validate(d, post)
                if not problems:
                    return d, "claude"
                print(f"  draft rejected: {'; '.join(problems)}", file=sys.stderr)
            except (RuntimeError, ValueError) as e:
                print(f"  draft failed: {e}", file=sys.stderr)
    return template_draft(post), "template"


def to_payload(post, draft):
    return {
        "post_url": post["link"], "title": post["title"], "summary": post["summary"] or None,
        "image_url": post["image"], "categories": post["categories"],
        "pub_date": post["pub_date"].isoformat() if post["pub_date"] else None,
        "link": tag_link(post["link"]), "fb_text": draft["facebook"].strip(), "ig_text": draft["instagram"].strip(),
    }


def ig_image_ok(url):
    """Instagram only takes a public https JPEG."""
    return bool(url) and url.startswith("https://") and re.search(r"\.jpe?g(\?|$)", url, re.I) is not None


def ensure_image(post, base, token, uploader=None, kicker="NEW ON THE BLOG", force_card=False):
    """Return the image URL to store: the blog's own JPEG if Instagram can use it, else a branded card."""
    if not force_card and ig_image_ok(post["image"]):
        return post["image"]
    try:
        card = social_image.render_card(post["title"], fetch_logo(), kicker)
        key = social_image.card_token(post["link"])
        status, _, _, raw = (uploader or http_request)(
            f"{base}/api/social-image/{key}", method="PUT", body=card, timeout=60,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "image/jpeg"})
        if status != 200:
            raise RuntimeError(f"upload returned {status}")
        return f"{base}/img/social/{key}.jpg"
    except Exception as e:  # never block a post over its picture
        print(f"  could not make a card image: {e}", file=sys.stderr)
        return post["image"]


def fetch_logo():
    try:
        status, _, _, raw = http_request(LOGO_URL, timeout=20, max_bytes=2_000_000)
        return raw if status == 200 else None
    except Exception:
        return None


# ---- run -------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--feed-file")
    args = ap.parse_args(argv)

    if args.feed_file:
        with open(args.feed_file, encoding="utf-8") as f:
            feed = f.read()
    else:
        status, _, _, raw = http_request(FEED_URL, timeout=30, max_bytes=5_000_000)
        if status != 200:
            raise SystemExit(f"Could not read the blog feed ({status}).")
        feed = raw.decode("utf-8", "replace")
    posts = parse_feed(feed)

    url = token = None
    known = set()
    if not args.dry_run:
        url, token = require_env("DASHBOARD_URL").rstrip("/"), require_env("API_TOKEN")
        status, _, _, raw = http_request(url + "/api/social/known", headers={"Authorization": f"Bearer {token}"})
        if status != 200:
            raise SystemExit(f"Dashboard said {status} when asking which posts it already has.")
        known = set(json.loads(raw).get("urls", []))

    todo = fresh(posts, known, max_age_days=MAX_AGE_DAYS)
    if not todo:
        print("No new blog posts to draft.")
        return
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    out = []
    for post in todo:
        draft, how = make_draft(post, api_key)
        print(f"Drafted '{post['title']}' ({how})")
        if not args.dry_run:
            post = dict(post, image=ensure_image(post, url, token))
        out.append(to_payload(post, draft))
    if args.dry_run:
        print(json.dumps(out, indent=2))
        return
    status, _, _, raw = http_request(url + "/api/social", method="POST", headers={"Authorization": f"Bearer {token}"}, body={"posts": out})
    print(status, raw.decode("utf-8", "ignore"))
    if status != 200:
        raise SystemExit("Dashboard rejected the posts.")
    print(f"Review them at {url}/social")


if __name__ == "__main__":
    main()
