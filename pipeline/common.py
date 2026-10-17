"""Shared helpers: config, SQLite storage, and a tiny stdlib HTTP client."""
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path

import envload  # noqa: F401  (loads .env)

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("OUTREACH_DB", ROOT / "data" / "outreach.db"))
USER_AGENT = "OcoosWebAuditBot/1.0 (+https://ocooswebconsulting.com)"

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id TEXT UNIQUE,
    company TEXT NOT NULL,
    category TEXT,
    city TEXT,
    address TEXT,
    phone TEXT,
    website TEXT,
    rating REAL,
    review_count INTEGER,
    email TEXT,
    email_source TEXT,
    status TEXT NOT NULL DEFAULT 'new',   -- new | audited | drafted | approved | sent | replied | booked | dead
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audits (
    lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
    reachable INTEGER,
    https INTEGER,
    has_viewport INTEGER,
    has_tap_to_call INTEGER,
    has_contact_form INTEGER,
    page_bytes INTEGER,
    mobile_score INTEGER,         -- PageSpeed performance 0-100, NULL if not run
    lcp_seconds REAL,
    findings_json TEXT NOT NULL,  -- list of verified findings, the ONLY facts the writer may use
    audited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS captures (
    lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
    video_path TEXT,
    still_path TEXT,
    token TEXT,                 -- unguessable id used in the public link
    video_url TEXT,             -- set after upload to the dashboard Worker
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS visual_audits (
    lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
    findings_json TEXT NOT NULL,   -- list of {"text", "service", "source"}; the only visual facts the writer may use
    mobile_path TEXT,
    desktop_path TEXT,
    token TEXT,                    -- unguessable id in the public page link
    page_url TEXT,                 -- set after upload to the dashboard Worker
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS drafts (
    lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
    angle TEXT,
    subject TEXT,
    email1 TEXT,
    email2 TEXT,
    email3 TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(path=None):
    p = Path(path) if path else DB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def http_request(url, method="GET", headers=None, body=None, timeout=20, retries=2, max_bytes=2_000_000):
    """Return (status, final_url, response_headers, bytes). Never raises on HTTP errors."""
    hdrs = {"User-Agent": USER_AGENT}
    hdrs.update(headers or {})
    if isinstance(body, (bytes, bytearray)):
        data = bytes(body)  # raw upload: caller sets Content-Type
    else:
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            hdrs.setdefault("Content-Type", "application/json")
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.geturl(), dict(r.headers), r.read(max_bytes)
        except urllib.error.HTTPError as e:
            return e.code, url, dict(e.headers or {}), e.read(200_000)
        except Exception as e:  # network / timeout / TLS
            last = e
            time.sleep(1 + attempt)
    return 0, url, {}, str(last).encode()


def require_env(name):
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"Missing environment variable {name}. See .env.example.")
    return v
