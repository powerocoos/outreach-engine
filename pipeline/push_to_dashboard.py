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
                  d.angle, d.subject, d.email1, d.email2, d.email3
           FROM leads l JOIN drafts d ON d.lead_id=l.id JOIN audits a ON a.lead_id=l.id
           WHERE l.status='drafted' AND l.email IS NOT NULL"""
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["findings"] = json.loads(d.pop("findings_json") or "[]")
        out.append(d)
    return out


def main():
    url = require_env("DASHBOARD_URL").rstrip("/")
    token = require_env("API_TOKEN")
    conn = connect()
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
