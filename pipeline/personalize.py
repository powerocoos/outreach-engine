"""Stage 3: write the 3-email sequence from VERIFIED findings only, then queue for human review.

Usage:
    python personalize.py --approve "1,3"   # mark reviewed drafts approved (or "all")
    python personalize.py              # uses Claude (needs ANTHROPIC_API_KEY)
    python personalize.py --template   # deterministic template, no API call
    python personalize.py --export review.csv   # export drafts for approval

Leads with zero verified findings are skipped: no finding, no outreach.
"""
import argparse
import csv
import json
import os
import re

import brand
from common import connect, http_request

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
MAX_WORDS = 125
SENDER = brand.SENDER_NAME
AGENCY = brand.BRAND_NAME

SYSTEM_PROMPT = f"""You write cold outreach as {brand.SENDER_NAME}, {brand.SENDER_TITLE} of {AGENCY}, a web
design agency serving {brand.SERVICE_AREA}. Services: {brand.SERVICES}. The offer is a {brand.OFFER}.
Write in first person ("I"), as one local professional writing to another.
You will receive a business and a list of VERIFIED FINDINGS about its website. Findings marked source "page"
were measured on the live page; "vision" findings are plain observations from screenshots, so word them with
"looks"/"appears".

Hard rules:
- Mention ONLY facts present in the findings or the business fields given. Never invent
  numbers, competitors, results, client names, or anything you were not told.
- Pick the single most customer-relevant finding and build the message around it.
- Each email is under {MAX_WORDS} words, conversational, no hype, no jargon, no emojis.
- Each email ends with a soft, low-friction question (e.g. "Worth a quick look?").
- Email 1: one short line saying who you are ("I'm {brand.SENDER_NAME} with {AGENCY}"), then the
  problem and why it costs them calls. Email 2: one useful, specific fix tied to the finding
  (no fake social proof). Email 3: short, polite break-up that offers the {brand.OFFER}.
- Never claim services, results, awards, or experience beyond the services listed above.
- If "video_url" is provided, Email 1 must include that exact URL once, introduced as a short
  screen recording of how the site looks on a phone. If it is not provided, never mention a
  video, recording, or screen capture anywhere.
- Speed numbers come from Google's mobile speed test, a simulated slower phone connection. Always
  attribute them ("in Google's mobile speed test", "Google's mobile test"), never say a page
  "takes N seconds on a phone" as if you timed it in person. Subject lines must not contain a
  timing number.
- Never state a cause as fact. You have not looked inside their site. Use "can", "often", "one
  common cause is", "I'd want to check".
- Give advice only about the verified finding. Do not suggest fixes for things the findings do not
  mention (for example phone-number placement, images, plugins, hosting) unless framed as a
  common cause you would check.
- Refer to "your website" or "your homepage"; never name a specific inner page.
- Do not include a signature, address, or unsubscribe text; those are added later.
- Each finding comes with "fits": the one service of ours it points to (website, design, seo, social). Build
  the message around the single best finding and, only if natural, the matching service. Emails 1 and 2 pitch
  that one thing only; never list several services there.
- If "page_url" is provided, Email 1 must include that exact URL once, introduced as a short private page
  showing what I saw on a phone and on a desktop. Do not mention a page, screenshot or link otherwise. Never
  include any other URL.
- Email 3 is the break-up, then ONE short sentence offering, as options, at most two of the listed services
  (not the one already pitched) in plain words, for example "I also help local businesses with Google
  Business Profile and social posts if that's more useful.", and it must still END with its closing question
  (the question comes last, after the services sentence). Use only services from the list above.
- If "fix_these_problems" is provided, your previous draft failed these checks; return a corrected draft.

Return ONLY JSON: {{"angle": str, "subject": str, "email1": str, "email2": str, "email3": str}}"""


def word_count(text):
    return len(text.split())


VIDEO_WORDS = ("video", "recording", "recorded", "screen capture", "screencast")


def validate_draft(d, findings, video_url=None, page_url=None):
    """Return a list of problems; empty list means the draft passes."""
    problems = []
    for k in ("angle", "subject", "email1", "email2", "email3"):
        if not isinstance(d.get(k), str) or not d[k].strip():
            problems.append(f"missing {k}")
    if problems:
        return problems
    for k in ("email1", "email2", "email3"):
        if word_count(d[k]) >= MAX_WORDS:
            problems.append(f"{k} is {word_count(d[k])} words")
        if "?" not in d[k]:
            problems.append(f"{k} has no question CTA")
    if re.search(r"\d+(\.\d+)?\s*(seconds?|secs?)\b", d["subject"], re.I):
        problems.append("subject states a timing number")
    for k in ("email1", "email2", "email3"):
        if re.search(r"\d+(\.\d+)?\s*seconds?\b", d[k], re.I) and "google" not in d[k].lower():
            problems.append(f"{k} gives a timing without attributing it to Google's test")
    allowed = {u for u in (video_url, page_url) if u}
    for k in ("email1", "email2", "email3"):
        for url in re.findall(r"https?://\S+", d[k]):
            if url.rstrip(".,)?!") not in allowed:
                problems.append(f"{k} contains a link that was not provided")
    if page_url and page_url not in d["email1"]:
        problems.append("email1 is missing the page link")
    if not page_url:
        for k in ("email1", "email2", "email3"):
            if "screenshot" in d[k].lower():
                problems.append(f"{k} mentions a screenshot but none exists")
    if video_url:
        if video_url not in d["email1"]:
            problems.append("email1 is missing the video link")
    else:
        for k in ("email1", "email2", "email3"):
            if any(w in d[k].lower() for w in VIDEO_WORDS):
                problems.append(f"{k} mentions a video but none exists")
    return problems


def finding_text(f):
    return f["text"] if isinstance(f, dict) else f


def as_payload(findings):
    """Findings for the writer: speed/HTTPS/mobile checks fit a website fix; visual ones carry their own service."""
    out = []
    for f in findings:
        if isinstance(f, dict):
            out.append({"finding": f["text"], "fits": f.get("service", "website"), "source": f.get("source", "page")})
        else:
            out.append({"finding": f, "fits": "website", "source": "page"})
    return out


def template_draft(lead, findings, video_url=None, page_url=None):
    """Deterministic fallback; also useful as a baseline to compare Claude's output against."""
    first = finding_text(findings[0])
    c, city = lead["company"], lead["city"] or "your area"
    clip = (f"\n\nI recorded a short screen capture of how it looks on a phone: {video_url}"
            if video_url else "")
    if page_url:
        clip = f"\n\nI put together a short private page showing what I saw on a phone and on a desktop: {page_url}"
    return {
        "angle": first,
        "subject": f"Google's mobile test on {c}'s site",
        "email1": (f"Hi there,\n\nI'm {brand.SENDER_NAME} with {brand.BRAND_NAME}. I looked at {c}'s "
                   f"website while checking local options in {city}. "
                   f"{first}\n\nMost people searching for a contractor are on a phone, and they "
                   f"usually tap the next result instead of working around a problem like that."
                   f"{clip}\n\nWorth a quick look?"),
        "email2": (f"Following up on {c}. The fix for this is usually small and quick: the issue I "
                   f"mentioned is one of the first things I'd address. I can send the specific "
                   f"steps whether or not we ever talk.\n\nWant me to send them?"),
        "email3": (f"I'll stop here so I don't clutter your inbox. If {c} ever wants a second "
                   f"opinion on the website, I'm glad to do a {brand.OFFER}.\n\n"
                   f"Should I close the file?"),
    }


def claude_draft(lead, findings, api_key, video_url=None, page_url=None, problems=None):
    payload = {
        "business": {k: lead[k] for k in ("company", "category", "city", "rating", "review_count")},
        "verified_findings": as_payload(findings),
    }
    if video_url:
        payload["video_url"] = video_url
    if page_url:
        payload["page_url"] = page_url
    if problems:
        payload["fix_these_problems"] = problems
    status, _, _, raw = http_request(
        "https://api.anthropic.com/v1/messages", method="POST", timeout=60,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        body={"model": MODEL, "max_tokens": 4000, "system": SYSTEM_PROMPT,
              "messages": [{"role": "user", "content": json.dumps(payload)}]},
    )
    if status != 200:
        raise RuntimeError(f"Anthropic API {status}: {raw[:200].decode('utf-8', 'ignore')}")
    blocks = json.loads(raw).get("content", [])
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    if "{" not in text:
        raise RuntimeError("Claude returned no text answer (blocks: %s)" % [b.get("type") for b in blocks])
    text = text[text.find("{"): text.rfind("}") + 1]
    return json.loads(text)


def run(use_template):
    api_key = None if use_template else os.environ.get("ANTHROPIC_API_KEY")
    if not use_template and not api_key:
        raise SystemExit("Set ANTHROPIC_API_KEY or pass --template.")
    conn = connect()
    rows = conn.execute(
        """SELECT l.*, a.findings_json, c.video_url, v.findings_json AS visual_json, v.page_url
           FROM leads l
           JOIN audits a ON a.lead_id=l.id
           LEFT JOIN captures c ON c.lead_id=l.id
           LEFT JOIN visual_audits v ON v.lead_id=l.id
           WHERE l.status='audited' AND l.email IS NOT NULL"""
    ).fetchall()
    for lead in rows:
        findings = json.loads(lead["findings_json"]) + json.loads(lead["visual_json"] or "[]")
        if not findings:
            print(f"skip {lead['company']}: no verified findings")
            continue
        page_url = lead["page_url"]
        video_url = None if page_url else lead["video_url"]  # one link in email 1
        problems = None
        draft = None
        for attempt in (1, 2):  # one retry, telling Claude what failed
            try:
                draft = (template_draft(lead, findings, video_url, page_url) if use_template
                         else claude_draft(lead, findings, api_key, video_url, page_url, problems))
            except (RuntimeError, ValueError) as e:
                print(f"error {lead['company']}: {e}")
                draft = None
                break
            problems = validate_draft(draft, findings, video_url, page_url)
            if not problems or use_template:
                break
        if draft is None:
            continue
        if problems:
            print(f"reject {lead['company']}: {problems}")
            continue
        conn.execute(
            "INSERT OR REPLACE INTO drafts (lead_id, angle, subject, email1, email2, email3) VALUES (?,?,?,?,?,?)",
            (lead["id"], draft["angle"], draft["subject"], draft["email1"], draft["email2"], draft["email3"]),
        )
        conn.execute("UPDATE leads SET status='drafted' WHERE id=?", (lead["id"],))
        conn.commit()
        print(f"drafted {lead['company']}")


INSTANTLY_COLUMNS = ["email", "first_name", "company_name", "website", "city", "category", "angle",
                     "video_url", "subject", "email1", "email2", "email3", "sender_name",
                     "sender_title", "brand_name", "brand_phone", "brand_website", "booking_link"]


def export_instantly(path):
    """CSV of approved leads for Instantly. Every column is usable as a {{variable}} in the sequence."""
    conn = connect()
    rows = conn.execute(
        """SELECT l.email, l.company, l.website, l.city, l.category, d.angle, d.subject,
                  d.email1, d.email2, d.email3, c.video_url
           FROM drafts d JOIN leads l ON l.id=d.lead_id LEFT JOIN captures c ON c.lead_id=l.id
           WHERE d.approved=1 AND l.email IS NOT NULL ORDER BY l.id"""
    ).fetchall()
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(INSTANTLY_COLUMNS)
        for r in rows:
            w.writerow([r["email"], "", r["company"], r["website"], r["city"] or "", r["category"] or "",
                        r["angle"], r["video_url"] or "", r["subject"], r["email1"], r["email2"],
                        r["email3"], brand.SENDER_NAME, brand.SENDER_TITLE, brand.BRAND_NAME,
                        brand.BRAND_PHONE, brand.BRAND_WEBSITE, brand.BOOKING_LINK])
    print(f"Wrote {len(rows)} approved leads to {path}.")
    gaps = brand.missing_for_sending()
    if gaps:
        print("Before sending, set in .env:", ", ".join(gaps))


def approve(ids):
    """Mark drafts approved by lead id ("1,3,7") or all of them ("all")."""
    conn = connect()
    if ids.strip().lower() == "all":
        cur = conn.execute("UPDATE drafts SET approved=1")
    else:
        wanted = [int(x) for x in ids.replace(" ", "").split(",") if x]
        cur = conn.execute(
            f"UPDATE drafts SET approved=1 WHERE lead_id IN ({','.join('?' * len(wanted))})", wanted)
    conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM drafts WHERE approved=1").fetchone()[0]
    print(f"Approved {cur.rowcount} draft(s). {n} approved in total.")


def export_review(path):
    conn = connect()
    rows = conn.execute(
        """SELECT l.id, l.company, l.email, l.website, d.angle, d.subject, d.email1, d.email2, d.email3, d.approved
           FROM drafts d JOIN leads l ON l.id=d.lead_id ORDER BY l.id"""
    ).fetchall()
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(rows[0].keys() if rows else ["no drafts"])
        for r in rows:
            w.writerow(list(r))
    print(f"Wrote {len(rows)} drafts to {path}. Set approved=1 for ones you OK, then import.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", action="store_true")
    ap.add_argument("--export")
    ap.add_argument("--export-instantly")
    ap.add_argument("--approve", help='lead ids to approve, e.g. "1,3,7,8", or "all"')
    args = ap.parse_args()
    if args.approve:
        approve(args.approve)
    elif args.export_instantly:
        export_instantly(args.export_instantly)
    elif args.export:
        export_review(args.export)
    else:
        run(args.template)
