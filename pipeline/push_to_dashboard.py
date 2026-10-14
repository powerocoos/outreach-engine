"""Stage 4: push APPROVED leads to the dashboard so webhook events can be matched to them.

Usage: DASHBOARD_URL=https://your-worker.workers.dev API_TOKEN=... python push_to_dashboard.py
Only drafts with approved=1 are pushed. Load these same leads into Instantly separately.
"""
from common import connect, http_request, require_env

import json


def main():
    url = require_env("DASHBOARD_URL").rstrip("/")
    token = require_env("API_TOKEN")
    conn = connect()
    rows = conn.execute(
        """SELECT l.company, l.email AS contact_email, l.phone, l.website, l.city, l.category,
                  d.angle AS hook_angle, a.mobile_score
           FROM leads l JOIN drafts d ON d.lead_id=l.id JOIN audits a ON a.lead_id=l.id
           WHERE d.approved=1 AND l.email IS NOT NULL"""
    ).fetchall()
    leads = [dict(r) for r in rows]
    status, _, _, raw = http_request(
        url + "/api/leads", method="POST", headers={"Authorization": f"Bearer {token}"},
        body={"leads": leads},
    )
    print(status, raw.decode("utf-8", "ignore"))
    if status == 200:
        conn.execute("UPDATE leads SET status='approved' WHERE id IN (SELECT lead_id FROM drafts WHERE approved=1) AND status='drafted'")
        conn.commit()


if __name__ == "__main__":
    main()
