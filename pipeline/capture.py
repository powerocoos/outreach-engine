"""Stage 2b: record a short phone-sized screen capture of each lead's website.

The clip shows exactly what a customer sees when searching on a phone: the first screen,
then a slow scroll. It is a real recording, so Email 1 can honestly say "I recorded what I saw".

Requires: playwright (+ chromium). ffmpeg is optional (converts .webm to .mp4 for wider playback).

Usage:  python capture.py [--limit 20]
Only leads that have verified findings and an email are captured.
"""
import argparse
import json
import shutil
import subprocess
import uuid
from pathlib import Path

from captions import OVERLAY_JS, captions_for
from common import ROOT, connect

VIEWPORT = {"width": 390, "height": 844}
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")
CAPTURE_DIR = ROOT / "data" / "captures"
MAX_SCREENS = 5          # never record more than this many screens of scrolling
STEP_PAUSE_MS = 1800     # time spent on each screen


def scroll_plan(page_height, viewport_height, max_screens=MAX_SCREENS):
    """Return the list of scrollY offsets to visit: top, then roughly one screen at a time."""
    if page_height <= viewport_height:
        return [0]
    step = int(viewport_height * 0.85)
    last = min(page_height - viewport_height, step * (max_screens - 1))
    offsets, y = [0], step
    while y < last:
        offsets.append(y)
        y += step
    if offsets[-1] != last:
        offsets.append(last)
    return offsets


def record(url, out_stem, captions=()):
    """Record `url` in a mobile viewport. Returns (video_path, still_path) or (None, None).

    `captions` (from verified findings) are shown one per screen as a banner at the top.
    """
    from playwright.sync_api import sync_playwright

    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CAPTURE_DIR / f"{out_stem}_tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    still = CAPTURE_DIR / f"{out_stem}.png"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport=VIEWPORT, user_agent=UA, is_mobile=True, has_touch=True,
            device_scale_factor=2, record_video_dir=str(tmp), record_video_size=VIEWPORT,
        )
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="load", timeout=30000)
            page.wait_for_timeout(2500)  # let the viewer see the first screen as a customer would
            page.screenshot(path=str(still))  # clean still, taken before any caption appears
            caps = list(captions)
            if caps:
                page.evaluate(OVERLAY_JS, caps[0])
                page.wait_for_timeout(1500)
            height = page.evaluate("document.documentElement.scrollHeight")
            for i, y in enumerate(scroll_plan(height, VIEWPORT["height"])[1:], start=1):
                if i < len(caps):
                    page.evaluate(OVERLAY_JS, caps[i])
                page.evaluate("y => window.scrollTo({top: y, behavior: 'smooth'})", y)
                page.wait_for_timeout(STEP_PAUSE_MS)
            # Short pages: still give every caption its moment on screen.
            for c in caps[len(scroll_plan(height, VIEWPORT["height"])):]:
                page.evaluate(OVERLAY_JS, c)
                page.wait_for_timeout(STEP_PAUSE_MS)
        except Exception as e:
            print(f"  capture failed for {url}: {e}")
            ctx.close()
            browser.close()
            shutil.rmtree(tmp, ignore_errors=True)
            return None, None
        video_tmp = Path(page.video.path())
        ctx.close()  # flushes the video file
        browser.close()
    webm = CAPTURE_DIR / f"{out_stem}.webm"
    shutil.move(str(video_tmp), webm)
    shutil.rmtree(tmp, ignore_errors=True)
    return to_mp4(webm), still


def to_mp4(webm):
    if not shutil.which("ffmpeg"):
        return webm
    mp4 = webm.with_suffix(".mp4")
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(webm), "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", "-an", str(mp4)],
        capture_output=True,
    )
    if r.returncode == 0:
        webm.unlink(missing_ok=True)
        return mp4
    return webm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()
    conn = connect()
    rows = conn.execute(
        """SELECT l.id, l.company, l.website, a.findings_json
           FROM leads l JOIN audits a ON a.lead_id=l.id
           LEFT JOIN captures c ON c.lead_id=l.id
           WHERE c.lead_id IS NULL AND l.email IS NOT NULL AND a.reachable=1 AND l.status IN ('audited','drafted')
           LIMIT ?""", (args.limit,)
    ).fetchall()
    for r in rows:
        findings = json.loads(r["findings_json"])
        if not findings:
            continue
        url = r["website"] if r["website"].startswith("http") else "https://" + r["website"]
        video, still = record(url, f"lead_{r['id']}", captions_for(findings))
        if not video:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO captures (lead_id, video_path, still_path, token) VALUES (?,?,?,?)",
            (r["id"], str(video), str(still), uuid.uuid4().hex),
        )
        conn.commit()
        print(f"captured {r['company']} -> {Path(video).name}")


if __name__ == "__main__":
    main()
