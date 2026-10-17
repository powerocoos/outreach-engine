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


def run(*args):
    print("$ python", *args, flush=True)
    return subprocess.run([sys.executable, *args], cwd=HERE).returncode


def main():
    if run("state.py", "pull") != 0:
        raise SystemExit("Could not load saved state; stopping so nothing is duplicated.")
    failed = []
    try:
        for t in load_targets():
            if run("lead_finder.py", "--category", t["category"], "--city", t["city"],
                   "--max", str(t.get("max", 20))) != 0:
                failed.append(f"lead_finder {t['category']} {t['city']}")
        for step in (("audit.py", "--limit", "60"), ("visual.py", "--limit", "40"), ("personalize.py",),
                     ("push_to_dashboard.py",)):
            if run(*step) != 0:
                failed.append(step[0])
    finally:
        if run("state.py", "push") != 0:
            failed.append("state push")
    if failed:
        raise SystemExit("Steps that failed: " + ", ".join(failed))
    print("Run complete. Review drafts on the dashboard.")


if __name__ == "__main__":
    main()
