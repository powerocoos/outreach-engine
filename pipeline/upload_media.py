"""Stage 2c: upload each recorded clip to the dashboard Worker (R2) and save its public link.

Usage: DASHBOARD_URL=https://<worker> API_TOKEN=... python upload_media.py
The link is https://<worker>/v/<token>; the token is unguessable and the page is noindex.
Run after capture.py and before personalize.py so Email 1 can link the clip.
"""
import urllib.parse
from pathlib import Path

from common import connect, http_request, require_env

CONTENT_TYPES = {".mp4": "video/mp4", ".webm": "video/webm"}


def main():
    base = require_env("DASHBOARD_URL").rstrip("/")
    token_hdr = require_env("API_TOKEN")
    conn = connect()
    rows = conn.execute(
        """SELECT c.lead_id, c.video_path, c.token, l.email, l.company
           FROM captures c JOIN leads l ON l.id=c.lead_id
           WHERE c.video_url IS NULL AND c.video_path IS NOT NULL AND l.email IS NOT NULL"""
    ).fetchall()
    for r in rows:
        path = Path(r["video_path"])
        ctype = CONTENT_TYPES.get(path.suffix)
        if not path.exists() or not ctype:
            print(f"skip {r['company']}: missing or unsupported file")
            continue
        url = f"{base}/api/media/{r['token']}?email={urllib.parse.quote(r['email'])}"
        status, _, _, raw = http_request(
            url, method="PUT", body=path.read_bytes(), timeout=120,
            headers={"Authorization": f"Bearer {token_hdr}", "Content-Type": ctype},
        )
        if status != 200:
            print(f"upload failed for {r['company']}: {status} {raw[:120].decode('utf-8', 'ignore')}")
            continue
        conn.execute("UPDATE captures SET video_url=? WHERE lead_id=?", (f"{base}/v/{r['token']}", r["lead_id"]))
        conn.commit()
        print(f"uploaded {r['company']} -> {base}/v/{r['token']}")


if __name__ == "__main__":
    main()
