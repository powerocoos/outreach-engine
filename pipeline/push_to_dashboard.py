"""Stage 4: send finished drafts to the dashboard Review page.

Usage: python push_to_dashboard.py
Every drafted lead with an email is uploaded as "pending". You approve, edit or reject it at
<DASHBOARD_URL>/review; approved drafts download as the Instantly CSV from that page.
Drafts already on the dashboard are never overwritten, so your decisions stick.
"""
import json

from common import connect, http_request, require_env

BATCH = 25


def collect(conn):
    rows = conn.execute(
        """SELECT l.id lead_id, l.company, l.email AS contact_email, l.website, l.city, l.category,
                  l.rating, l.review_count, a.mobile_score, a.findings_json,
                  v.findings_json AS visual_json, v.page_url, v.polish,
                  d.angle, d.subject, d.email1, d.email2, d.email3
           FROM leads l JOIN drafts d ON d.lead_id=l.id JOIN audits a ON a.lead_id=l.id
           LEFT JOIN visual_audits v ON v.lead_id=l.id
           WHERE l.status='drafted' AND l.email IS NOT NULL"""
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["findings"] = json.loads(d.pop("findings_json") or "[]")
        d["findings"] += [f["text"] for f in json.loads(d.pop("visual_json") or "[]")]
        page_url = d.pop("page_url", None)
        if page_url:
            d["findings"].append(f"Private page with screenshots: {page_url}")
        out.append(d)
    return out


def collect_skipped(conn):
    """Sites skipped as well kept, not yet shown on the dashboard's Skipped page."""
    rows = conn.execute(
        """SELECT l.id lead_id, l.company, l.website, l.city, l.category, l.rating, l.review_count,
                  v.polish, v.findings_json
           FROM leads l JOIN visual_audits v ON v.lead_id=l.id
           WHERE l.status='polished' AND l.skip_pushed=0 AND l.website IS NOT NULL"""
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["findings"] = [f["text"] for f in json.loads(d.pop("findings_json") or "[]") if f.get("text")]
        out.append(d)
    return out


def push_skipped(conn, url, token):
    skipped = collect_skipped(conn)
    if not skipped:
        return
    status, _, _, raw = http_request(
        url + "/api/skipped", method="POST", headers={"Authorization": f"Bearer {token}"},
        body={"skipped": [{k: v for k, v in d.items() if k != "lead_id"} for d in skipped]})
    if status != 200:
        print("Could not send skipped sites to the dashboard:", status, raw[:200].decode("utf-8", "ignore"))
        return
    conn.executemany("UPDATE leads SET skip_pushed=1 WHERE id=?", [(d["lead_id"],) for d in skipped])
    conn.commit()
    print(f"Sent {len(skipped)} skipped site(s) to the Skipped page.")


def main():
    url = require_env("DASHBOARD_URL").rstrip("/")
    token = require_env("API_TOKEN")
    conn = connect()
    push_skipped(conn, url, token)
    drafts = collect(conn)
    if not drafts:
        print("No new drafts to send.")
        return
    sent = 0
    for i in range(0, len(drafts), BATCH):
        chunk = drafts[i:i + BATCH]
        status, _, _, raw = http_request(
            url + "/api/drafts", method="POST", headers={"Authorization": f"Bearer {token}"},
            body={"drafts": [{k: v for k, v in d.items() if k != "lead_id"} for d in chunk]},
        )
        print(status, raw.decode("utf-8", "ignore"))
        if status != 200:
            raise SystemExit("Dashboard rejected the drafts; nothing marked as sent from this batch.")
        conn.executemany("UPDATE leads SET status='queued' WHERE id=?", [(d["lead_id"],) for d in chunk])
        conn.commit()
        sent += len(chunk)
    print(f"Sent {sent} draft(s). Review them at {url}/review")


if __name__ == "__main__":
    main()
