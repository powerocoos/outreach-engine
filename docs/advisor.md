# Advisor for email drafting (experimental, off by default)

The drafting model (`ANTHROPIC_MODEL`, Sonnet by default) can consult a stronger model (`OUTREACH_ADVISOR_MODEL`,
Opus by default) once per draft. The advisor only gives guidance on which finding to lead with, which one service it
points to, and the opening hook. It never writes the email, and `validate_draft` checks every draft exactly as before.
The advisor tool is a beta (`advisor-tool-2026-03-01`), so check the pairing is supported before relying on it:
https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool

## See the difference first (nothing is saved or sent)

```
python pipeline/state.py pull                    # needs DASHBOARD_URL and API_TOKEN
python pipeline/compare_advisor.py --limit 5     # needs ANTHROPIC_API_KEY
```

This drafts the same leads twice (baseline and advisor) and writes `advisor_comparison.md` with both versions side
by side, whether each passed validation on the first try, and how many times the advisor was consulted. Read the
emails and decide which you would rather approve.

## Turn it on

- Local: set `OUTREACH_ADVISOR=1` in `.env`.
- GitHub Actions: add a repository variable (Settings, Secrets and variables, Actions, Variables) named
  `OUTREACH_ADVISOR` with the value `1`. Delete it or empty it to turn the advisor off again.

Each run prints a line like `advisor (claude-opus-5-5): consulted 4 time(s) across 5 draft call(s)`.

## How to judge it

Compare approve vs edit vs reject rates on the Review page for runs with and without it, and the reply and booking
rate once sends begin. Each advisor call re-reads the full conversation uncached, so cost grows with consults; the
prompt asks for one consult per draft (a second only when fixing validation problems).
