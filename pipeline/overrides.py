"""Stage 0: apply "Send anyway" choices made on the dashboard's Skipped page.

Usage: python overrides.py
Asks the dashboard which skipped sites you chose to send. Each one is reset to 'audited' with
force_send=1, so the visual step publishes its private page without the polish skip and the
normal drafting and Review steps follow. Then the dashboard is told they are handled.
"""
import json

from common import connect, http_request, require_env


def apply_overrides(conn, websites):
    """Reset skipped leads for these websites; returns the company names that will be drafted."""
    done = []
    for w in websites:
        row = conn.execute("SELECT id, company FROM leads WHERE website=? AND status='polished'", (w,)).fetchone()
        if not row:
            continue
        conn.execute("DELETE FROM visual_audits WHERE lead_id=?", (row["id"],))
        conn.execute("UPDATE leads SET status='audited', force_send=1 WHERE id=?", (row["id"],))
        done.append(row["company"])
    conn.commit()
    return done


def main():
    url = require_env("DASHBOARD_URL").rstrip("/")
    token = require_env("API_TOKEN")
    auth = {"Authorization": f"Bearer {token}"}
    status, _, _, raw = http_request(url + "/api/skipped/overrides", headers=auth)
    if status != 200:
        print("Could not read send-anyway choices:", status)
        return
    websites = json.loads(raw).get("websites", [])
    if not websites:
        print("No send-anyway choices.")
        return
    conn = connect()
    done = apply_overrides(conn, websites)
    print("Send anyway:", ", ".join(done) or "none found in saved state")
    http_request(url + "/api/skipped/done", method="POST", headers=auth, body={"websites": websites})


if __name__ == "__main__":
    main()
