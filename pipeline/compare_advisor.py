"""Draft the same leads with and without the advisor and write a side-by-side report.

Usage:
    python pipeline/state.py pull                      # get the saved database (needs DASHBOARD_URL, API_TOKEN)
    python pipeline/compare_advisor.py --limit 5       # needs ANTHROPIC_API_KEY
    python pipeline/compare_advisor.py --ids 12,15 --out compare.md

Read-only: the database is opened read-only, nothing is saved as a draft, and nothing is sent.
Each lead is drafted once per side (first attempt only, no retry) so the report shows how often each
side passes validate_draft on the first try. Then you read the emails and judge which are better.
"""
import argparse
import json
import os
import sqlite3
import sys

import personalize
from common import DB_PATH

QUERY = """SELECT l.*, a.findings_json, c.video_url, v.findings_json AS visual_json, v.page_url
           FROM leads l
           JOIN audits a ON a.lead_id=l.id
           LEFT JOIN captures c ON c.lead_id=l.id
           LEFT JOIN visual_audits v ON v.lead_id=l.id
           WHERE l.status IN ('audited','drafted') AND l.email IS NOT NULL"""


def load_leads(db_path, limit=5, ids=None):
    """Leads that have findings, newest first, read from a read-only connection."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        sql, args = QUERY, []
        if ids:
            sql += f" AND l.id IN ({','.join('?' * len(ids))})"
            args += list(ids)
        sql += " ORDER BY l.id DESC"
        leads = []
        for row in conn.execute(sql, args):
            findings = json.loads(row["findings_json"]) + json.loads(row["visual_json"] or "[]")
            if not findings:
                continue
            page_url = row["page_url"]
            video_url = None if page_url else row["video_url"]  # same rule as personalize.run
            leads.append({"lead": dict(row), "findings": findings, "video_url": video_url, "page_url": page_url})
            if not ids and len(leads) >= limit:
                break
        return leads
    finally:
        conn.close()


def draft_both(item, api_key, draft_fn=None):
    """First-attempt draft with and without the advisor, each validated the way personalize.run does."""
    draft_fn = draft_fn or personalize.claude_draft
    out = {}
    for label, use_advisor in (("baseline", False), ("advisor", True)):
        before = personalize.ADVISOR_STATS["consults"]
        try:
            d = draft_fn(item["lead"], item["findings"], api_key, item["video_url"], item["page_url"],
                         None, advisor=use_advisor)
            problems = personalize.validate_draft(d, item["findings"], item["video_url"], item["page_url"])
            err = None
        except (RuntimeError, ValueError) as e:
            d, problems, err = None, [], str(e)
        out[label] = {"draft": d, "problems": problems, "error": err,
                      "consults": personalize.ADVISOR_STATS["consults"] - before}
    return out


def _words(d):
    return sum(personalize.word_count(d[k]) for k in ("email1", "email2", "email3")) if d else 0


def _side(label, title, r):
    lines = [f"### {title}"]
    if r["error"]:
        return lines + [f"Error: {r['error']}", ""]
    d = r["draft"]
    status = "passes validation" if not r["problems"] else "FAILS: " + "; ".join(r["problems"])
    extra = f", advisor consulted {r['consults']}x" if label == "advisor" else ""
    lines += [f"{status}; {_words(d)} words across 3 emails{extra}.", "",
              f"**Angle:** {d['angle']}", f"**Subject:** {d['subject']}", ""]
    for k, name in (("email1", "Email 1"), ("email2", "Email 2"), ("email3", "Email 3")):
        lines += [f"**{name}**", ""] + ["> " + ln for ln in d[k].splitlines()] + [""]
    return lines


def render(results, models):
    n = len(results)
    ok = {s: sum(1 for _, r in results if r[s]["draft"] and not r[s]["problems"]) for s in ("baseline", "advisor")}
    consults = sum(r["advisor"]["consults"] for _, r in results)
    lines = ["# Advisor comparison", "",
             f"Executor: {models[0]}. Advisor: {models[1]}. Leads compared: {n}.", "",
             "| | Baseline | With advisor |", "|---|---|---|",
             f"| Passed validation on first try | {ok['baseline']}/{n} | {ok['advisor']}/{n} |",
             f"| Advisor consults | 0 | {consults} |", "",
             "Read the emails below and note which side you would rather approve. That is the real test.", ""]
    for item, r in results:
        L = item["lead"]
        lines += [f"## {L['company']} ({L['city'] or 'no city'}, {L['category'] or 'no category'})", "",
                  "Findings: " + " | ".join(personalize.finding_text(f) for f in item["findings"]), ""]
        lines += _side("baseline", "Baseline", r["baseline"])
        lines += _side("advisor", "With advisor", r["advisor"])
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(DB_PATH), help="database file (default: the pipeline database)")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--ids", help='lead ids, e.g. "12,15" (overrides --limit)')
    ap.add_argument("--out", default="advisor_comparison.md")
    args = ap.parse_args(argv)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("Set ANTHROPIC_API_KEY.")
    if not os.path.exists(args.db):
        raise SystemExit(f"No database at {args.db}. Run: python pipeline/state.py pull")
    ids = [int(x) for x in args.ids.replace(" ", "").split(",") if x] if args.ids else None
    items = load_leads(args.db, args.limit, ids)
    if not items:
        raise SystemExit("No leads with findings to compare.")
    results = []
    for item in items:
        print(f"drafting {item['lead']['company']} ...")
        results.append((item, draft_both(item, api_key)))
    with open(args.out, "w") as f:
        f.write(render(results, (personalize.MODEL, personalize.ADVISOR_MODEL)))
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    sys.exit(main())
