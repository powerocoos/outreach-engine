"""One full unattended run: find leads, audit sites, draft emails, send drafts to the dashboard.

Used by the scheduled GitHub Action (.github/workflows/outreach.yml) and runnable by hand:
    python run_all.py
Targets come from config/targets.json. Override for one run with TARGET_CATEGORY, TARGET_CITY
and optionally TARGET_MAX in the environment. State (the SQLite file) is pulled from and pushed
back to the dashboard, so runs from different machines share one history.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGETS = HERE.parent / "config" / "targets.json"


def load_targets(env=os.environ, path=TARGETS):
    cat, city = (env.get("TARGET_CATEGORY") or "").strip(), (env.get("TARGET_CITY") or "").strip()
    if cat and city:
        return [{"category": cat, "city": city, "max": int(env.get("TARGET_MAX") or 20)}]
    return json.loads(Path(path).read_text())


def interleave(targets):
    """Reorder so trades alternate (HVAC Gainesville, plumber Gainesville, ...), so each run covers
    several trades instead of working one trade for days at a time."""
    groups = {}
    for t in targets:
        groups.setdefault(t["category"], []).append(t)
    out = []
    for i in range(max((len(g) for g in groups.values()), default=0)):
        out += [g[i] for g in groups.values() if i < len(g)]
    return out


def weekday_index(day):
    """Count of weekdays before `day`, so consecutive weekday runs take consecutive slices and one
    pass over the list takes exactly len/per_run weekdays (the calendar day left gaps on weekends)."""
    n = day.toordinal() - 1  # ordinal 1 (Jan 1, year 1) was a Monday
    return (n // 7) * 5 + min(n % 7, 5)


def todays_targets(targets, today=None, per_run=None):
    """A rotating slice of the target list, so a long list is worked through over several weekdays
    instead of making one run too long. Overrides (one-off category/city) are never sliced."""
    import datetime
    per_run = per_run or int(os.environ.get("TARGETS_PER_RUN") or 2)
    if len(targets) <= per_run:
        return targets
    targets = interleave(targets)
    today = today or datetime.date.today()
    start = (weekday_index(today) * per_run) % len(targets)
    return [targets[(start + i) % len(targets)] for i in range(per_run)]


def run(*args):
    print("$ python", *args, flush=True)
    return subprocess.run([sys.executable, *args], cwd=HERE).returncode


def _run_all(chosen_out):
    if run("state.py", "pull") != 0:
        raise SystemExit("Could not load saved state; stopping so nothing is duplicated.")
    failed = []
    try:
        env_override = bool((os.environ.get("TARGET_CATEGORY") or "").strip() and (os.environ.get("TARGET_CITY") or "").strip())
        chosen = load_targets() if env_override else todays_targets(load_targets())
        chosen_out.extend(chosen)
        print("Targets today:", "; ".join(f"{t['category']} / {t['city']}" for t in chosen), flush=True)
        for t in chosen:
            if run("lead_finder.py", "--category", t["category"], "--city", t["city"],
                   "--max", str(t.get("max", 20))) != 0:
                failed.append(f"lead_finder {t['category']} {t['city']}")
        for step in (("overrides.py",), ("audit.py", "--limit", "60"), ("visual.py", "--limit", "40"), ("personalize.py",),
                     ("push_to_dashboard.py",)):
            if run(*step) != 0:
                failed.append(step[0])
    finally:
        if run("state.py", "push") != 0:
            failed.append("state push")
    if failed:
        raise SystemExit("Steps that failed: " + ", ".join(failed))
    print("Run complete. Review drafts on the dashboard.")


def report(start, ok, failed, targets):
    """Tell the dashboard how the run went, so its Health page can warn about failures. Never fails the run."""
    try:
        from common import connect, http_request
        url, token = (os.environ.get("DASHBOARD_URL") or "").rstrip("/"), os.environ.get("API_TOKEN")
        if not url or not token:
            return
        conn = connect()
        new_leads = conn.execute("SELECT COUNT(*) FROM leads WHERE created_at >= ?", (start,)).fetchone()[0]
        drafted = conn.execute("SELECT COUNT(*) FROM drafts WHERE created_at >= ?", (start,)).fetchone()[0]
        http_request(url + "/api/runs", method="POST", headers={"Authorization": f"Bearer {token}"}, body={
            "ok": ok, "failed": failed, "new_leads": new_leads, "drafted": drafted,
            "targets": "; ".join(f"{t['category']} / {t['city']}" for t in targets)})
    except Exception as e:  # noqa: BLE001 - reporting is best effort
        print("Could not report the run to the dashboard:", e)


def main():
    import datetime
    start = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    chosen = []
    try:
        _run_all(chosen)
    except SystemExit as e:
        msg = str(e.code) if e.code not in (None, 0) else ""
        if msg:
            report(start, False, [msg], chosen)
        raise
    report(start, True, [], chosen)


if __name__ == "__main__":
    main()
