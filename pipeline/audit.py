"""Stage 2: audit each lead's website and record only VERIFIED findings.

Checks (all observable, none guessed):
  - site reachable, served over HTTPS
  - mobile viewport meta tag present
  - tap-to-call link (tel:) present
  - contact form present
  - Google PageSpeed mobile performance score + LCP (if PAGESPEED_API_KEY set or quota allows)

Usage:  python audit.py [--limit 50]
"""
import argparse
import json
import re
import urllib.parse

from common import connect, http_request

PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
VIEWPORT_RE = re.compile(r'<meta[^>]+name=["\']viewport["\']', re.I)
TEL_RE = re.compile(r'href=["\']tel:', re.I)
FORM_RE = re.compile(r"<form\b", re.I)


def analyze_html(html, final_url):
    """Pure function: HTML + final URL -> dict of observed facts."""
    return {
        "https": final_url.lower().startswith("https://"),
        "has_viewport": bool(VIEWPORT_RE.search(html)),
        "has_tap_to_call": bool(TEL_RE.search(html)),
        "has_contact_form": bool(FORM_RE.search(html)),
        "page_bytes": len(html.encode("utf-8", "ignore")),
    }


def build_findings(facts, mobile_score=None, lcp_seconds=None):
    """Turn observed facts into plain-language findings the writer is allowed to cite."""
    f = []
    if not facts["https"]:
        f.append("The site loads without HTTPS, so browsers show a 'Not secure' warning.")
    if not facts["has_viewport"]:
        f.append("The page has no mobile viewport setting, so it renders as a shrunken desktop page on phones.")
    if not facts["has_tap_to_call"]:
        f.append("The homepage has no tap-to-call phone link for people searching on a phone.")
    if mobile_score is not None and mobile_score < 50:
        f.append(f"Google PageSpeed gives the mobile version a performance score of {mobile_score}/100.")
    if lcp_seconds is not None and lcp_seconds > 4.0:
        f.append(f"In Google's mobile speed test, the main content takes about {lcp_seconds:.1f} seconds to appear.")
    return f


def pagespeed(url, api_key=None):
    q = {"url": url, "strategy": "mobile", "category": "performance"}
    if api_key:
        q["key"] = api_key
    status, _, _, raw = http_request(PSI_URL + "?" + urllib.parse.urlencode(q), timeout=90, retries=1)
    if status != 200:
        return None, None
    try:
        lh = json.loads(raw)["lighthouseResult"]
        score = round(lh["categories"]["performance"]["score"] * 100)
        lcp = lh["audits"]["largest-contentful-paint"]["numericValue"] / 1000.0
        return score, lcp
    except (KeyError, ValueError, TypeError):
        return None, None


def audit_lead(lead, api_key=None, run_pagespeed=True):
    url = lead["website"] if lead["website"].startswith("http") else "https://" + lead["website"]
    parts = urllib.parse.urlsplit(url)
    url = f"{parts.scheme}://{parts.netloc}/"  # audit the homepage, not an inner page from the listing
    status, final_url, _, body = http_request(url, timeout=20, retries=1)
    if status != 200:
        return {"reachable": 0, "https": 0, "has_viewport": 0, "has_tap_to_call": 0,
                "has_contact_form": 0, "page_bytes": 0, "mobile_score": None,
                "lcp_seconds": None, "findings": []}
    facts = analyze_html(body.decode("utf-8", "ignore"), final_url)
    score, lcp = pagespeed(final_url, api_key) if run_pagespeed else (None, None)
    return {"reachable": 1, **{k: int(v) for k, v in facts.items()},
            "mobile_score": score, "lcp_seconds": lcp,
            "findings": build_findings(facts, score, lcp)}


def main():
    import os
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--no-pagespeed", action="store_true")
    args = ap.parse_args()
    api_key = os.environ.get("PAGESPEED_API_KEY")
    conn = connect()
    rows = conn.execute(
        "SELECT * FROM leads WHERE status='new' AND website IS NOT NULL AND email IS NOT NULL LIMIT ?", (args.limit,)
    ).fetchall()
    for lead in rows:
        r = audit_lead(lead, api_key, not args.no_pagespeed)
        conn.execute(
            """INSERT OR REPLACE INTO audits
               (lead_id, reachable, https, has_viewport, has_tap_to_call, has_contact_form,
                page_bytes, mobile_score, lcp_seconds, findings_json)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (lead["id"], r["reachable"], r["https"], r["has_viewport"], r["has_tap_to_call"],
             r["has_contact_form"], r["page_bytes"], r["mobile_score"], r["lcp_seconds"],
             json.dumps(r["findings"])),
        )
        conn.execute("UPDATE leads SET status='audited' WHERE id=?", (lead["id"],))
        conn.commit()
        print(f"{lead['company']}: {len(r['findings'])} verified findings")


if __name__ == "__main__":
    main()
