"""Draws the app icon: a teal tile with a white waveform, its middle part framed by trim handles."""
from pathlib import Path
from PIL import Image, ImageDraw
import math

OUT = Path(__file__).resolve().parent.parent / "icons"
SS = 4  # draw big, then shrink, for smooth edges


def vgradient(top, bottom, size):
    w, h = size
    img = Image.new("RGB", size)
    t, b = [tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for c in (top, bottom)]
    for y in range(h):
        f = y / (h - 1)
        ImageDraw.Draw(img).line([(0, y), (w, y)], fill=tuple(round(t[i] + (b[i] - t[i]) * f) for i in range(3)))
    return img


def draw(scale=1.0):
    k = 1024 * SS
    img = vgradient("#1fb489", "#0b5e49", (k, k)).convert("RGBA")
    d = ImageDraw.Draw(img)
    cx, cy = k / 2, k / 2
    n, span = 15, 0.62 * k * scale
    step = span / n
    sel0, sel1 = 4, 10  # bars inside the trim frame
    for i in range(n):
        x = cx - span / 2 + (i + 0.5) * step
        a = 0.28 + 0.72 * abs(math.sin(i * 0.9 + 0.6)) * (0.55 + 0.45 * abs(math.sin(i * 2.3)))
        h = a * 0.42 * k * scale
        col = (255, 255, 255, 255) if sel0 <= i <= sel1 else (150, 222, 198, 255)
        d.rounded_rectangle((x - step * 0.28, cy - h / 2, x + step * 0.28, cy + h / 2), radius=step * 0.28, fill=col)
    # trim frame
    x0 = cx - span / 2 + sel0 * step - step * 0.12
    x1 = cx - span / 2 + (sel1 + 1) * step + step * 0.12
    top, bot = cy - 0.27 * k * scale, cy + 0.27 * k * scale
    hw, lw = 0.045 * k * scale, 0.016 * k * scale
    gold = (255, 214, 102, 255)
    d.rounded_rectangle((x0 - hw, top, x0, bot), radius=hw * 0.45, fill=gold)
    d.rounded_rectangle((x1, top, x1 + hw, bot), radius=hw * 0.45, fill=gold)
    d.rectangle((x0, top, x1, top + lw), fill=gold)
    d.rectangle((x0, bot - lw, x1, bot), fill=gold)
    return img


OUT.mkdir(exist_ok=True)
full = draw().resize((1024, 1024), Image.LANCZOS)
full.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")
full.resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png")
full.convert("RGB").resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png")
draw(scale=0.78).resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png")
print("icons written to", OUT)
