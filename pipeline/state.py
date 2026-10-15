"""Keep the pipeline database in the dashboard's storage so any machine (or GitHub Actions) shares it.

Usage:
    python state.py pull    # download the saved database (first run: starts empty)
    python state.py push    # upload it again
"""
import sys

from common import DB_PATH, http_request, require_env

MAX = 200_000_000


def main(argv):
    if len(argv) != 2 or argv[1] not in ("pull", "push"):
        raise SystemExit(__doc__)
    url = require_env("DASHBOARD_URL").rstrip("/") + "/api/state"
    hdr = {"Authorization": f"Bearer {require_env('API_TOKEN')}"}
    if argv[1] == "pull":
        status, _, _, raw = http_request(url, headers=hdr, timeout=120, max_bytes=MAX)
        if status == 404:
            print("No saved state yet; starting fresh.")
        elif status == 200:
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            DB_PATH.write_bytes(raw)
            print(f"Pulled state ({len(raw)} bytes).")
        else:
            raise SystemExit(f"Could not pull state: {status} {raw[:120].decode('utf-8', 'ignore')}")
    else:
        if not DB_PATH.exists():
            raise SystemExit("No local database to push.")
        status, _, _, raw = http_request(
            url, method="PUT", headers={**hdr, "Content-Type": "application/octet-stream"},
            body=DB_PATH.read_bytes(), timeout=120)
        if status != 200:
            raise SystemExit(f"Could not push state: {status} {raw[:120].decode('utf-8', 'ignore')}")
        print("Pushed state.")


if __name__ == "__main__":
    main(sys.argv)
