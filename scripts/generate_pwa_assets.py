#!/usr/bin/env python3
"""Generate the small, dependency-free PWA icon and iOS splash assets."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

INK = "#18332f"
CREAM = "#f9f5e9"
ACCENT = "#f0a681"

def font(size):
    candidates = [
        "/System/Library/Fonts/Supplemental/NotoSansCJK.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()

def centered(draw, text, box, typeface, fill):
    left, top, right, bottom = draw.textbbox((0, 0), text, font=typeface)
    draw.text(((box[0] + box[2] - right + left) / 2, (box[1] + box[3] - bottom + top) / 2), text, font=typeface, fill=fill)

def draw_mark(size, splash=False):
    image = Image.new("RGB", (size, size), INK)
    draw = ImageDraw.Draw(image)
    margin = round(size * (0.16 if not splash else 0.34))
    draw.rounded_rectangle((margin, margin, size - margin, size - margin), radius=round(size * 0.18), fill=ACCENT)
    centered(draw, "N", (margin, margin, size - margin, size - margin), font(round(size * 0.34)), INK)
    return image

def save_icon(size):
    draw_mark(size).save(OUT / f"icon-{size}.png", optimize=True)

for size in (192, 512):
    save_icon(size)

for size in ((750, 1334), (1170, 2532)):
    width, height = size
    image = Image.new("RGB", size, INK)
    draw = ImageDraw.Draw(image)
    mark_size = round(width * 0.28)
    mark = draw_mark(mark_size, splash=True)
    image.paste(mark, ((width - mark_size) // 2, round(height * 0.33)))
    centered(draw, "國小消息牆", (0, round(height * 0.58), width, round(height * 0.7)), font(round(width * 0.075)), CREAM)
    image.save(OUT / f"splash-{width}x{height}.png", optimize=True)

print("generated PWA assets in assets/")
