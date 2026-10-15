"""Branded 1080x1080 "NEW ON THE BLOG" card, used when a blog post has no usable JPEG for Instagram.

render_card(title) -> JPEG bytes. The card is stored on the dashboard (R2) and served from a public link,
because Instagram only accepts a public https JPEG URL.
"""
import hashlib
import io
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import brand

FONT_DIR = Path(__file__).parent / "fonts"
SIZE = 1080
MARGIN = 96
TOP, BOTTOM = (7, 42, 77), (21, 83, 135)
WHITE, ACCENT, SOFT = (255, 255, 255), (124, 196, 255), (190, 214, 238)
GOLD = (244, 190, 60)


def _font(name, size):
    return ImageFont.truetype(str(FONT_DIR / name), size)


def _gradient():
    img = Image.new("RGB", (SIZE, SIZE))
    px = ImageDraw.Draw(img)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        px.line([(0, y), (SIZE, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return img


def _wrap(draw, words, font, max_w):
    lines, cur = [], []
    for w in words:
        trial = " ".join(cur + [w])
        if cur and draw.textlength(trial, font=font) > max_w:
            lines.append(cur)
            cur = [w]
        else:
            cur.append(w)
    if cur:
        lines.append(cur)
    return lines


def split_title(title):
    """Return (lead, tail): the tail (after a colon, else the last third) is drawn in light blue."""
    title = re.sub(r"\s+", " ", title).strip()
    if ":" in title:
        lead, tail = title.split(":", 1)
        if lead.strip() and tail.strip():
            return lead.strip() + ":", tail.strip()
    words = title.split()
    cut = max(1, len(words) - max(1, len(words) // 3)) if len(words) > 3 else len(words)
    return " ".join(words[:cut]), " ".join(words[cut:])


def render_card(title, logo_bytes=None):
    img = _gradient()
    d = ImageDraw.Draw(img)
    max_w = SIZE - 2 * MARGIN
    lead, tail = split_title(title)
    tagged = [(w, WHITE) for w in lead.split()] + [(w, ACCENT) for w in tail.split()]
    words = [w for w, _ in tagged]
    colors = {}
    for i, (_, c) in enumerate(tagged):
        colors[i] = c

    # Largest title size that fits in the space between the label and the footer.
    for size in range(104, 47, -4):
        font = _font("Poppins-Bold.ttf", size)
        lines = _wrap(d, words, font, max_w)
        if len(lines) * size * 1.18 <= 520 and len(lines) <= 6:
            break
    if logo_bytes:
        try:
            logo = Image.open(io.BytesIO(logo_bytes)).convert("RGBA")
            logo.thumbnail((300, 110))
            plate = Image.new("RGBA", (logo.width + 36, logo.height + 24), (255, 255, 255, 255))
            plate.paste(logo, (18, 12), logo)
            img.paste(plate.convert("RGB"), (MARGIN, 84))
        except Exception:
            pass
    label_y = 250
    d.text((MARGIN, label_y), "NEW ON THE BLOG", font=_font("Poppins-Medium.ttf", 34), fill=WHITE)
    d.rectangle([MARGIN, label_y + 56, MARGIN + 74, label_y + 62], fill=GOLD)

    y = label_y + 96
    i = 0
    for line in lines:
        x = MARGIN
        for w in line:
            d.text((x, y), w, font=font, fill=colors[i])
            x += d.textlength(w + " ", font=font)
            i += 1
        y += round(size * 1.18)

    foot = _font("Poppins-Bold.ttf", 38)
    d.text((MARGIN, SIZE - 190), brand.BRAND_NAME, font=foot, fill=WHITE)
    d.text((MARGIN, SIZE - 138), "Ocala & Gainesville, FL", font=_font("Poppins-Medium.ttf", 30), fill=SOFT)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=90, optimize=True)
    return out.getvalue()


def card_token(link):
    """Stable 32-hex id so re-running never creates a second card for the same post."""
    return hashlib.sha256(link.encode()).hexdigest()[:32]
