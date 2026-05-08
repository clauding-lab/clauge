#!/usr/bin/env python3
"""
Render a monochrome template tray icon for Clauge.

Design: a stylized gauge/dial — partial outer ring (≈75% coverage) + a needle
pointing toward "1 o'clock" + a small center dot. Echoes the colored
clauge-menubar-18px.svg without the brand chroma (template icons must be
monochrome — macOS tints them automatically: white on dark menubar, black
on light).

Two sizes:
  - 22×22 px → tray-icon.png (1x base)
  - 44×44 px → tray-icon@2x.png (Retina)

The Tauri code (src-tauri/src/tray.rs:43) loads only `tray-icon.png` via
`include_bytes!`, but we keep the @2x sibling in case future Tauri versions
support it or it gets used by the bundle pipeline.
"""

from PIL import Image, ImageDraw
import math
from pathlib import Path

OUT = Path("/Users/adnanrashid/Projects/clauge/src-tauri/icons")


def draw_gauge(size: int) -> Image.Image:
    """
    Render the gauge at the requested size. All measurements are derived from
    `size` so the geometry scales identically at 22 and 44.

    Black RGBA on transparent background — Tauri's `icon_as_template(true)`
    flag tells macOS to ignore the RGB and use the alpha as a mask.
    """
    # Render at 4× resolution for clean anti-aliasing, then downsample.
    # PIL's `Image.LANCZOS` resample gives noticeably smoother strokes than
    # drawing directly at the target size for 22×22.
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Geometry — keep ≈10% margin so the icon doesn't bump against the
    # menubar edge.
    cx = cy = s / 2
    margin = s * 0.10
    outer_r = (s - 2 * margin) / 2
    inner_r = outer_r * 0.55
    stroke_w = max(2, int(s * 0.07))

    # Outer ring — partial arc evoking a 75%-full usage gauge. Mirrors the
    # SVG in public/clauge-menubar-18px.svg: dasharray 33/44 = ~75% visible,
    # rotate(135) → gap centered at the bottom-left.
    # PIL's `arc` measures degrees clockwise from the 3 o'clock position.
    # Sweep from 135° to 405° (= 45° next loop) covers 270° clockwise, ending
    # in the upper-right quadrant — same visual as the SVG.
    bbox_outer = [cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r]
    draw.arc(bbox_outer, start=135, end=405, fill=(0, 0, 0, 255), width=stroke_w)

    # Inner ring — full circle, thinner stroke
    inner_stroke = max(1, int(s * 0.025))
    bbox_inner = [cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r]
    draw.ellipse(bbox_inner, outline=(0, 0, 0, 255), width=inner_stroke)

    # Needle: line from center outward toward "1 o'clock" (-45° in PIL coords,
    # i.e. up-and-right). Length ≈ outer_r so it just kisses the outer ring.
    angle_deg = -45
    angle_rad = math.radians(angle_deg)
    needle_len = outer_r * 0.92
    needle_w = max(2, int(s * 0.035))
    nx = cx + needle_len * math.cos(angle_rad)
    ny = cy + needle_len * math.sin(angle_rad)
    draw.line([(cx, cy), (nx, ny)], fill=(0, 0, 0, 255), width=needle_w)

    # Center dot — fills any visible needle pivot
    dot_r = max(1, int(s * 0.06))
    draw.ellipse(
        [cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
        fill=(0, 0, 0, 255),
    )

    # Downsample to the actual target size
    img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    img1x = draw_gauge(22)
    img2x = draw_gauge(44)

    # PIL writes a fairly compact PNG by default; `optimize=True` shaves a
    # little more.
    img1x.save(OUT / "tray-icon.png", "PNG", optimize=True)
    img2x.save(OUT / "tray-icon@2x.png", "PNG", optimize=True)

    p1 = OUT / "tray-icon.png"
    p2 = OUT / "tray-icon@2x.png"
    print(f"wrote {p1} ({p1.stat().st_size} bytes, {img1x.size})")
    print(f"wrote {p2} ({p2.stat().st_size} bytes, {img2x.size})")


if __name__ == "__main__":
    main()
