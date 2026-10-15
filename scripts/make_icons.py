"""Generate placeholder home-screen icons (iOS needs PNG, not SVG)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
BG, TILES = (22, 120, 130), [(255, 138, 61), (108, 99, 255), (76, 211, 138), (255, 207, 63)]


def icon(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    pad, gap = size * 0.2, size * 0.06
    cell = (size - 2 * pad - gap) / 2
    for i, color in enumerate(TILES):
        x = pad + (i % 2) * (cell + gap)
        y = pad + (i // 2) * (cell + gap)
        d.rounded_rectangle([x, y, x + cell, y + cell], radius=cell * 0.25, fill=color)
    return img


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, size in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]:
        icon(size).save(OUT / name)
        print("wrote", OUT / name)
