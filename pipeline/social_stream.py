"""Extra Facebook + Instagram posts that are not blog posts: practical tips and anonymous site-check results.

Two kinds, both reviewed on <DASHBOARD_URL>/social like blog posts (nothing posts until you approve):
  tip       - a topic from config/social_topics.json; Claude may use ONLY the facts listed for the topic.
  teardown  - a statistic computed from the sites the outreach engine has audited ("14 of 38 local HVAC websites ...").
              No business is ever named; a number is only used when at least MIN_SAMPLE sites back it up.

Usage:
    python social_stream.py              # draft what is due and send it to the dashboard
    python social_stream.py --dry-run    # print drafts, send nothing
    python social_stream.py --force      # ignore the weekday rule (the queue limit still applies)
"""
import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

import brand
import social
import social_image
from common import connect, http_request, require_env

TOPICS_PATH = Path(__file__).resolve().parent.parent / "config" / "social_topics.json"
QUEUE_TARGET = int(os.environ.get("SOCIAL_STREAM_QUEUE", "2"))     # tip/teardown posts waiting for review or posting
DAYS = {int(d) for d in os.environ.get("SOCIAL_STREAM_DAYS", "0,2,4").split(",")}   # Mon, Wed, Fri (Python weekday)
MIN_SAMPLE = 15
MIN_COUNT, MIN_PCT = 3, 15

# What each measured finding means, in plain words. Matched against the stored finding text.
PATTERNS = [
    ("wide-page", "wider than the screen", "had a homepage that is wider than a phone screen, so visitors must scroll sideways"),
    ("no-call-button", ("tap-to-call link is not visible", "no phone number or call/quote button", "no clear call-to-action"),
     "had no visible call button or phone number on the first phone screen"),
    ("no-city", "Neither the page title nor the main heading mentions", "did not mention the city in the page title or main heading"),
    ("no-schema", "structured data", "had no local-business structured data in the homepage code"),
    ("old-footer", "The footer shows ©", "showed a copyright year at least three years old in the footer"),
    ("no-reviews", "does not mention customer reviews", "did not mention customer reviews on the homepage"),
    ("no-social", "links to no social media pages", "linked to no social media pages"),
]

STREAM_PROMPT = f"""You write social media posts for {brand.BRAND_NAME}, a web design agency serving {brand.SERVICE_AREA}.
You receive ONE item: either a "tip" (a topic with a list of facts) or a "site_check" (a measured result from
checking local business websites on a phone).
Use ONLY what appears in the item. Never invent statistics, prices, clients, results, quotes or promises.
Every number you write must appear in the item. Never name or hint at a specific business or website.
Plain, friendly, practical. No hype, no clickbait, no all-caps, no judging or mocking the businesses.

- Facebook: {social.FB_WORDS[0]}-{social.FB_WORDS[1]} words (aim for 70-100; count them). Open with a concrete hook. Give 2-4 short takeaways the reader can act on today.
  No URL (the link is attached separately). At most 1 emoji. No hashtags.
- Instagram: {social.IG_WORDS[0]}-{social.IG_WORDS[1]} words (aim for 70-110, not counting hashtags), same facts, a bit more casual, line breaks between ideas. No URL. End the caption
  body with "Link in bio." then a blank line and 5-8 relevant hashtags mixing topic and local tags
  (for example #OcalaFlorida #NorthCentralFlorida #SmallBusiness). At most 2 emoji.
- Never include a phone number or email address.
- Closing line: for a tip, invite the reader to message us with questions about their own website. For a site_check,
  say we offer a {brand.OFFER} and they can message us to get one.
- Do not claim services beyond: {brand.SERVICES}.

Return ONLY JSON: {{"facebook": str, "instagram": str}}"""


# ---- choosing what to draft ----------------------------------------------------------
def load_topics(path=TOPICS_PATH):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def scope_phrase(categories):
    cats = [c.lower() for c in categories if c]
    if cats and all("hvac" in c for c in cats):
        return "local HVAC company websites"
    return "local service-business websites"


def compute_stats(conn, min_sample=MIN_SAMPLE):
    """Aggregate facts from audited sites. Returns [] until enough sites back a number."""
    stats = []
    rows = conn.execute(
        "SELECT v.findings_json, l.category FROM visual_audits v JOIN leads l ON l.id=v.lead_id").fetchall()
    if len(rows) >= min_sample:
        n = len(rows)
        scope = scope_phrase({r["category"] for r in rows})
        texts = [" ".join(f.get("text", "") for f in json.loads(r["findings_json"]) if f.get("source") == "page") for r in rows]
        for key, needles, desc in PATTERNS:
            needles = (needles,) if isinstance(needles, str) else needles
            count = sum(1 for t in texts if any(nd in t for nd in needles))
            pct = round(100 * count / n)
            if count >= MIN_COUNT and pct >= MIN_PCT:
                stats.append({"id": key, "n": n, "count": count, "pct": pct, "scope": scope, "desc": desc})
    return stats


def stat_sentence(s):
    return f"Of {s['n']} {s['scope']} checked on a phone, {s['count']} ({s['pct']}%) {s['desc']}."


def choose(known_urls, topics, stats, queued, today, force=False, target=QUEUE_TARGET):
    """Return [(kind, key, item)] to draft this run. Pure function so it can be tested."""
    if not force and today.weekday() not in DAYS:
        return []
    room = target - queued
    if room <= 0:
        return []
    month = today.strftime("%Y-%m")
    site = brand.BRAND_WEBSITE.rstrip("/")
    tip_done = sum(1 for u in known_urls if "/#tip-" in u)
    check_done = sum(1 for u in known_urls if "/#check-" in u)
    fresh_stats = [s for s in stats if f"{site}/#check-{s['id']}-{month}" not in known_urls]
    fresh_topics = [t for t in topics if f"{site}/#tip-{t['id']}" not in known_urls]
    out = []
    for _ in range(room):
        if fresh_stats and tip_done > check_done:      # keep the two kinds roughly alternating
            s = fresh_stats.pop(0)
            out.append(("teardown", f"{site}/#check-{s['id']}-{month}", s))
            check_done += 1
        elif fresh_topics:
            t = fresh_topics.pop(0)
            out.append(("tip", f"{site}/#tip-{t['id']}", t))
            tip_done += 1
        elif fresh_stats:
            s = fresh_stats.pop(0)
            out.append(("teardown", f"{site}/#check-{s['id']}-{month}", s))
            check_done += 1
        else:
            break
    return out if force else out[:1]   # one new item per run keeps the pace gentle


# ---- drafting ------------------------------------------------------------------------
def source_post(kind, item):
    """Shape an item like a blog post so social.validate() can check numbers against it."""
    if kind == "tip":
        return {"title": item["title"], "summary": "", "headings": [], "text": " ".join(item["facts"]), "link": ""}
    return {"title": "Local website check", "summary": stat_sentence(item), "headings": [],
            "text": stat_sentence(item) + " " + brand.OFFER, "link": ""}   # the offer's own numbers (15-minute) are allowed


def item_payload(kind, item):
    if kind == "tip":
        return {"kind": "tip", "topic": item["title"], "facts": item["facts"]}
    return {"kind": "site_check", "result": stat_sentence(item), "sample_size": item["n"], "count": item["count"],
            "percent": item["pct"]}


def claude_stream_draft(kind, item, api_key, problems=None):
    payload = item_payload(kind, item)
    if problems:
        payload["fix_these_problems"] = problems   # a retry tells Claude exactly what failed
    status, _, _, raw = http_request(
        "https://api.anthropic.com/v1/messages", method="POST", timeout=60,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        body={"model": social.MODEL, "max_tokens": 2000, "system": STREAM_PROMPT,
              "messages": [{"role": "user", "content": json.dumps(payload)}]})
    if status != 200:
        raise RuntimeError(f"Anthropic API {status}: {raw[:200].decode('utf-8', 'ignore')}")
    text = "".join(b.get("text", "") for b in json.loads(raw).get("content", []) if b.get("type") == "text")
    if "{" not in text:
        raise RuntimeError("Claude returned no JSON")
    return json.loads(text[text.find("{"): text.rfind("}") + 1])


EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF]")


def stream_problems(draft, kind, item):
    problems = social.validate(draft, source_post(kind, item))
    if len(EMOJI_RE.findall(draft.get("facebook", ""))) > 1:
        problems.append("facebook has more than 1 emoji")
    if len(EMOJI_RE.findall(draft.get("instagram", ""))) > 2:
        problems.append("instagram has more than 2 emoji")
    text = (draft.get("facebook", "") + " " + draft.get("instagram", "")).lower()
    if kind == "teardown" and ("free" not in text or "audit" not in text):
        problems.append("site check post does not mention the free audit")
    return problems


def make_stream_draft(kind, item, api_key, drafter=claude_stream_draft):
    """Two tries with Claude; no fallback template (a bland post is worse than no post). Returns draft or None."""
    problems = None
    for _ in range(2):
        try:
            d = drafter(kind, item, api_key, problems)
        except (RuntimeError, ValueError) as e:
            print(f"  draft failed: {e}", file=sys.stderr)
            continue
        problems = stream_problems(d, kind, item)
        if not problems:
            return d
        print(f"  draft rejected: {'; '.join(problems)}", file=sys.stderr)
    return None


def to_stream_payload(kind, key, item, draft, image_url, today):
    campaign = "tips" if kind == "tip" else "site-checks"
    title = item["title"] if kind == "tip" else "Local website check: " + item["desc"]
    return {
        "post_url": key, "title": title[:300], "summary": None, "image_url": image_url,
        "categories": ["Tip" if kind == "tip" else "Site check"], "pub_date": today.isoformat() + "T09:00:00+00:00",
        "link": social.tag_link(brand.BRAND_WEBSITE, campaign=campaign), "fb_text": draft["facebook"].strip(),
        "ig_text": draft["instagram"].strip(), "kind": kind,
    }


def card_title(kind, item):
    if kind == "tip":
        return item["title"]
    return f"{item['count']} of {item['n']}: {item['desc']}"


# ---- run -----------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    today = datetime.date.today()
    known, queued = set(), 0
    url = token = None
    if not args.dry_run:
        url, token = require_env("DASHBOARD_URL").rstrip("/"), require_env("API_TOKEN")
        status, _, _, raw = http_request(url + "/api/social/known", headers={"Authorization": f"Bearer {token}"})
        if status != 200:
            raise SystemExit(f"Dashboard said {status} when asking which posts it already has.")
        data = json.loads(raw)
        known, queued = set(data.get("urls", [])), int(data.get("queued_stream", 0))
    stats = compute_stats(connect())
    todo = choose(known, load_topics(), stats, queued, today, force=args.force)
    if not todo:
        print(f"Nothing to draft (queue {queued}/{QUEUE_TARGET}, weekday rule {'off' if args.force else 'on'}).")
        return
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("Set ANTHROPIC_API_KEY.")
    out = []
    for kind, key, item in todo:
        draft = make_stream_draft(kind, item, api_key)
        if not draft:
            print(f"Skipped {kind} {key}: no draft passed the checks.")
            continue
        image = None
        if not args.dry_run:
            image = social.ensure_image({"title": card_title(kind, item), "link": key, "image": None}, url, token,
                                        kicker="WEBSITE TIP" if kind == "tip" else "LOCAL SITE CHECK", force_card=True)
        out.append(to_stream_payload(kind, key, item, draft, image, today))
        print(f"Drafted {kind}: {key}")
    if not out:
        return
    if args.dry_run:
        print(json.dumps(out, indent=2))
        return
    status, _, _, raw = http_request(url + "/api/social", method="POST", headers={"Authorization": f"Bearer {token}"},
                                     body={"posts": out})
    print(status, raw.decode("utf-8", "ignore"))
    if status != 200:
        raise SystemExit("Dashboard rejected the posts.")
    print(f"Review them at {url}/social")


if __name__ == "__main__":
    main()
