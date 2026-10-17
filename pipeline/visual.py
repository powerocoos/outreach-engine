"""Stage 2b: screenshots plus visual findings for each lead that has an email.

For every lead it loads the homepage on a phone and on a desktop, takes a first-screen screenshot of each,
and records two kinds of findings:
  * "page" findings: measured from the live page (is a phone number or call button visible on the first
    phone screen, is the page wider than the screen, what year the footer shows, does the title name the city,
    is there local-business structured data, ...). These are facts, not opinions.
  * "vision" findings: at most two plain observations Claude makes from the screenshots, limited to a fixed
    list of categories and checked for hedged wording and no invented numbers.
Each finding carries the service it points to (website, design, seo, social). The screenshots and findings
are uploaded to the dashboard Worker, which serves a private page at <DASHBOARD_URL>/a/<token> that the
outreach email can link to.

Requires: playwright (+ chromium). Needs ANTHROPIC_API_KEY for vision findings (page findings work without it)
and DASHBOARD_URL + API_TOKEN to publish the private page.

Usage: python visual.py [--limit 40] [--no-vision]
"""
import argparse
import base64
import datetime
import json
import os
import re
import uuid
from pathlib import Path

from common import ROOT, connect, http_request

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
SHOT_DIR = ROOT / "data" / "shots"
MOBILE = {"width": 390, "height": 844}
DESKTOP = {"width": 1366, "height": 768}
UA_MOBILE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")
SERVICES = ("website", "design", "seo", "social")
VISION_CATEGORIES = {
    "first_screen_clarity": "website",
    "outdated_design": "design",
    "readability": "design",
    "trust": "website",
    "layout_problem": "website",
}
MAX_VISION = 2

# Runs inside the phone-sized page. Returns plain facts only.
PROBE_JS = r"""
() => {
  const vw = innerWidth, vh = innerHeight;
  const inView = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' &&
           r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
  };
  const tel = [...document.querySelectorAll('a[href^="tel:"]')];
  const ctaRe = /\b(call|quote|estimate|schedule|book|contact|appointment|request)\b/i;
  const ctas = [...document.querySelectorAll('a,button')].filter((e) => {
    const t = (e.innerText || '').trim();
    return t && t.length < 40 && ctaRe.test(t);
  });
  let above = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode, p = n.parentElement;
    if (p && n.textContent.trim() && inView(p)) above += ' ' + n.textContent.trim();
  }
  const body = document.body.innerText || '';
  const years = [...body.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => +m[1]);
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(' ');
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.href.toLowerCase());
  const h1 = document.querySelector('h1');
  return {
    tel_count: tel.length,
    tel_in_view: tel.some(inView),
    phone_text_in_view: /\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/.test(above),
    cta_in_view: ctas.some(inView),
    overflow_x: document.documentElement.scrollWidth > Math.min(vw, screen.width) + 4,
    title: document.title || '',
    h1: h1 ? (h1.innerText || '').trim().slice(0, 160) : '',
    copyright_year: years.length ? Math.max(...years) : null,
    has_local_schema: /schema\.org/i.test(ld) && /(LocalBusiness|HVACBusiness|Plumber|Electrician|RoofingContractor|HomeAndConstructionBusiness|ProfessionalService|Organization)/i.test(ld),
    has_social_links: links.some((l) => /facebook\.com|instagram\.com|youtube\.com|x\.com|twitter\.com|linkedin\.com/.test(l)),
    mentions_reviews: /\b(reviews?|testimonials?)\b/i.test(body),
    above_fold_chars: above.length,
  };
}
"""


def city_word(city):
    return re.split(r"[,\s]", (city or "").strip())[0].lower()


def dom_findings(facts, city, this_year=None):
    """Facts from the live page -> findings. Pure function; the only source of 'page' findings."""
    year = this_year or datetime.date.today().year
    out = []

    def add(text, service):
        out.append({"text": text, "service": service, "source": "page"})

    if facts.get("overflow_x"):
        add("On a phone the homepage is wider than the screen, so visitors have to scroll sideways.", "website")
    if facts.get("tel_count", 0) > 0 and not facts.get("tel_in_view") and not facts.get("cta_in_view"):
        add("On a phone, the tap-to-call link is not visible on the first screen without scrolling.", "design")
    elif facts.get("tel_count", 0) == 0 and not facts.get("phone_text_in_view") and not facts.get("cta_in_view"):
        add("On a phone, no phone number or call/quote button is visible on the first screen.", "design")
    elif not facts.get("cta_in_view"):
        add("On a phone, no clear call-to-action button (call, quote, schedule) is visible on the first screen.", "design")
    cw = city_word(city)
    title = (facts.get("title") or "")
    if cw and cw not in title.lower() and cw not in (facts.get("h1") or "").lower():
        add(f"Neither the page title nor the main heading mentions {city.split(',')[0].strip()}, "
            "which is what local searchers type.", "seo")
    if not facts.get("has_local_schema"):
        add("I did not find local-business structured data in the homepage code, which helps Google show "
            "business details in search.", "seo")
    cy = facts.get("copyright_year")
    if cy and cy <= year - 3:
        add(f"The footer shows © {cy}, which can make a site look unmaintained.", "website")
    if not facts.get("mentions_reviews"):
        add("The homepage does not mention customer reviews or testimonials.", "website")
    if not facts.get("has_social_links"):
        add("The homepage links to no social media pages.", "social")
    return out


VISION_PROMPT = f"""You are looking at two screenshots of a local business's homepage: the first is the first
screen on a phone, the second is the first screen on a desktop. Facts measured from the live page are provided
as JSON and are correct.

Report at most {MAX_VISION} observations about what is PLAINLY visible in the screenshots and would matter to a
customer deciding whether to call. Each observation uses one category:
  first_screen_clarity (it is unclear what the business does or where it works),
  outdated_design (the design looks clearly dated),
  readability (text is hard to read: tiny, low contrast, crowded),
  trust (nothing on the first screen builds trust: no reviews, license, real photos),
  layout_problem (something looks broken: overlapping, cut off, covered by a banner or popup).
Rules: describe only what is visible; no numbers, no scores, no guesses about the business or its results; do
not repeat anything the measured facts already say; hedge opinions ("looks", "appears"); each text at most 30
words, plain language, no jargon. If nothing is clearly wrong, return an empty list.

Return ONLY JSON: {{"observations": [{{"category": str, "text": str}}]}}"""


def validate_vision(obs):
    """Keep only observations that are in an allowed category, short, hedged-neutral, and number-free."""
    out = []
    for o in obs[:MAX_VISION]:
        if not isinstance(o, dict):
            continue
        cat, text = o.get("category"), (o.get("text") or "").strip()
        if cat not in VISION_CATEGORIES or not text:
            continue
        if len(text.split()) > 35 or re.search(r"\d", text) or "http" in text.lower():
            continue
        out.append({"text": text, "service": VISION_CATEGORIES[cat], "source": "vision"})
    return out


def claude_vision(facts, mobile_jpeg, desktop_jpeg, api_key):
    def img(b):
        return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                            "data": base64.b64encode(b).decode()}}
    content = [img(mobile_jpeg), img(desktop_jpeg), {"type": "text", "text": json.dumps({"measured_facts": facts})}]
    status, _, _, raw = http_request(
        "https://api.anthropic.com/v1/messages", method="POST", timeout=90,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        body={"model": MODEL, "max_tokens": 700, "system": VISION_PROMPT,
              "messages": [{"role": "user", "content": content}]},
    )
    if status != 200:
        raise RuntimeError(f"Anthropic API {status}: {raw[:200].decode('utf-8', 'ignore')}")
    text = "".join(b.get("text", "") for b in json.loads(raw).get("content", []) if b.get("type") == "text")
    if "{" not in text:
        return []
    return validate_vision(json.loads(text[text.find("{"): text.rfind("}") + 1]).get("observations", []))


def capture(url, stem):
    """Load the homepage on phone and desktop. Returns (facts, mobile_path, desktop_path) or None."""
    from playwright.sync_api import sync_playwright

    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    mpath, dpath = SHOT_DIR / f"{stem}_m.jpg", SHOT_DIR / f"{stem}_d.jpg"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            ctx = browser.new_context(viewport=MOBILE, user_agent=UA_MOBILE, is_mobile=True, has_touch=True,
                                      device_scale_factor=2)
            page = ctx.new_page()
            page.goto(url, wait_until="load", timeout=30000)
            page.wait_for_timeout(2500)
            facts = page.evaluate(PROBE_JS)
            page.screenshot(path=str(mpath), type="jpeg", quality=72)
            ctx.close()
            ctx = browser.new_context(viewport=DESKTOP)
            page = ctx.new_page()
            page.goto(url, wait_until="load", timeout=30000)
            page.wait_for_timeout(2500)
            page.screenshot(path=str(dpath), type="jpeg", quality=72)
            ctx.close()
            return facts, mpath, dpath
        except Exception as e:  # unreachable, blocked, timeout
            print(f"  capture failed for {url}: {e}")
            return None
        finally:
            browser.close()


def publish(base, api_token, token, lead, findings, mpath, dpath):
    """Upload the screenshots and findings; returns the public page URL or None."""
    hdr = {"Authorization": f"Bearer {api_token}"}
    for kind, path in (("mobile", mpath), ("desktop", dpath)):
        s, _, _, raw = http_request(f"{base}/api/audit/{token}/{kind}.jpg", method="PUT", timeout=60,
                                    body=Path(path).read_bytes(), headers={**hdr, "Content-Type": "image/jpeg"})
        if s != 200:
            print(f"  upload of {kind} screenshot failed: {s} {raw[:100].decode('utf-8', 'ignore')}")
            return None
    s, _, _, raw = http_request(
        f"{base}/api/audit/{token}", method="PUT", headers=hdr,
        body={"email": lead["email"], "company": lead["company"], "website": lead["website"],
              "findings": findings})
    if s != 200:
        print(f"  page upload failed: {s} {raw[:100].decode('utf-8', 'ignore')}")
        return None
    return f"{base}/a/{token}"


def preview(sites, city, api_key, base, api_token):
    for i, site in enumerate(x.strip() for x in sites.split(",") if x.strip()):
        url = site if site.startswith("http") else "https://" + site
        got = capture(url, f"preview_{i}")
        if not got:
            print(f"{site}: could not load")
            continue
        facts, mpath, dpath = got
        findings = dom_findings(facts, city)
        if api_key:
            try:
                findings += claude_vision(facts, mpath.read_bytes(), dpath.read_bytes(), api_key)
            except (RuntimeError, ValueError) as e:
                print(f"  vision skipped: {e}")
        print(f"== {site}")
        for f in findings:
            print(f"  [{f['source']}/{f['service']}] {f['text']}")
        if base and api_token:
            lead = {"email": "", "company": re.sub(r"^https?://(www\.)?", "", url).rstrip("/"), "website": url}
            page = publish(base, api_token, uuid.uuid4().hex, lead, findings, mpath, dpath)
            print(f"  page: {page}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--no-vision", action="store_true")
    ap.add_argument("--preview", help="comma-separated site URLs: print findings and publish test pages; touches no leads")
    ap.add_argument("--city", default="Ocala, FL", help="city used for the preview's local-search check")
    args = ap.parse_args()
    api_key = None if args.no_vision else os.environ.get("ANTHROPIC_API_KEY")
    base, api_token = (os.environ.get("DASHBOARD_URL") or "").rstrip("/"), os.environ.get("API_TOKEN")
    if args.preview:
        return preview(args.preview, args.city, api_key, base, api_token)
    conn = connect()
    rows = conn.execute(
        """SELECT l.id, l.company, l.website, l.city, l.email FROM leads l
           JOIN audits a ON a.lead_id=l.id
           LEFT JOIN visual_audits v ON v.lead_id=l.id
           WHERE v.lead_id IS NULL AND l.email IS NOT NULL AND a.reachable=1 AND l.status='audited'
           LIMIT ?""", (args.limit,)
    ).fetchall()
    for r in rows:
        url = r["website"] if r["website"].startswith("http") else "https://" + r["website"]
        got = capture(url, f"lead_{r['id']}")
        if not got:
            continue
        facts, mpath, dpath = got
        findings = dom_findings(facts, r["city"])
        if api_key:
            try:
                findings += claude_vision(facts, mpath.read_bytes(), dpath.read_bytes(), api_key)
            except (RuntimeError, ValueError) as e:
                print(f"  vision skipped for {r['company']}: {e}")
        token = uuid.uuid4().hex
        page_url = publish(base, api_token, token, r, findings, mpath, dpath) if base and api_token else None
        conn.execute(
            "INSERT OR REPLACE INTO visual_audits (lead_id, findings_json, mobile_path, desktop_path, token, page_url) "
            "VALUES (?,?,?,?,?,?)", (r["id"], json.dumps(findings), str(mpath), str(dpath), token, page_url))
        conn.commit()
        print(f"visual {r['company']}: {len(findings)} findings, page {'yes' if page_url else 'no'}")


if __name__ == "__main__":
    main()
