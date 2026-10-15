"""Load KEY=value lines from the project's .env into os.environ (existing variables win)."""
import os
from pathlib import Path


def load_env(path=None):
    p = Path(path) if path else Path(__file__).resolve().parent.parent / ".env"
    if not p.is_file():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.split(" #")[0].strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


load_env()
