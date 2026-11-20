"""Draws the ScenePack icon: a fanned pack of three cream cards on a flat orange tile (no gradients).

Every shape is a signed-distance field, so each size is rendered crisply on its own.
Writes assets/icon.ico (all Windows sizes), icon.png (64), icon_128.png, icon_512.png.
Needs numpy:  python tools/make_icon.py
"""
import struct
import zlib
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "assets"


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float64) / 255


def rot(x, y, cx, cy, deg):
    a = np.radians(deg)
    dx, dy = x - cx, y - cy
    return dx * np.cos(a) + dy * np.sin(a), -dx * np.sin(a) + dy * np.cos(a)


def sd_box(x, y, hw, hh, r):
    qx, qy = np.abs(x) - (hw - r), np.abs(y) - (hh - r)
    out = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    return out + np.minimum(np.maximum(qx, qy), 0) - r


def sd_triangle(x, y, pts):
    """Signed distance to a convex triangle (exact inside, good enough outside for anti-aliasing)."""
    d = None
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        ex, ey = x1 - x0, y1 - y0
        n = np.hypot(ex, ey)
        dist = ((x - x0) * ey - (y - y0) * ex) / n  # positive outside for clockwise points
        d = dist if d is None else np.maximum(d, dist)
    return d


def cover(d, px):
    return np.clip(0.5 - d / px, 0, 1)


def over(dst, color, alpha):
    a = alpha[..., None]
    dst[..., :3] = dst[..., :3] * (1 - a) + color * a
    dst[..., 3:] = dst[..., 3:] * (1 - a) + a


def render(size):
    """Flat colours only: orange tile, three cream cards with hard (unblurred) offset shadows."""
    px = 1.0 / size
    c = (np.arange(size) + 0.5) / size
    x, y = np.meshgrid(c, c)
    img = np.zeros((size, size, 4))
    small = size <= 24

    orange, orange_dark = hexrgb("#ef5326"), hexrgb("#c8401b")
    plum = hexrgb("#16141d")
    tile = sd_box(x - 0.5, y - 0.5, 0.47, 0.47, 0.22 if not small else 0.16)
    a = cover(tile, px)
    over(img, orange, a)
    if size >= 48:  # a crisp darker rim keeps the tile edge sharp on light and dark taskbars
        rim = np.clip(1 - np.abs(tile + 0.012) / 0.012, 0, 1)
        over(img, orange_dark, rim * a * 0.7)

    cream = [hexrgb("#d9d1c3"), hexrgb("#ece6da"), hexrgb("#fbf8f1")]
    if small:  # at 16-24 px one bold card reads better than three thin ones
        cards = [(6, 0.5, 0.52)]
        hw, hh, r = 0.25, 0.31, 0.05
    else:
        cards = [(-16, 0.43, 0.50), (-5, 0.48, 0.505), (8, 0.535, 0.525)]
        hw, hh, r = 0.2, 0.27, 0.04
    off = max(0.02, 1.6 / size)
    for k, (deg, cx, cy) in enumerate(cards):
        front = k == len(cards) - 1
        u, v = rot(x - off, y - off * 1.6, cx, cy, deg)
        over(img, plum, cover(sd_box(u, v, hw, hh, r), px) * a * 0.92)  # hard, unblurred shadow
        u, v = rot(x, y, cx, cy, deg)
        card = sd_box(u, v, hw, hh, r)
        inside = cover(card, px) * a
        over(img, cream[k if not small else 2], inside)
        if size >= 32:  # hairline so the stacked cards read as separate
            edge = np.clip(1 - np.abs(card) / (0.9 * px), 0, 1)
            over(img, plum, edge * a * 0.32)
        if not front:
            continue
        if size >= 48:  # film sprocket holes down both long edges of the front card
            for side in (-1, 1):
                for i in range(5):
                    hy = -hh + 0.055 + i * (2 * hh - 0.11) / 4
                    hole = sd_box(u - side * (hw - 0.04), v - hy, 0.014, 0.019, 0.006)
                    over(img, plum, cover(hole, px) * inside * 0.85)
        s = 0.085 if not small else 0.12
        tri = sd_triangle(u, v, [(-s * 0.72, -s), (s * 1.0, 0.0), (-s * 0.72, s)])
        over(img, orange, cover(tri, px) * inside)
    return (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)

def png(arr):
    h, w = arr.shape[:2]
    raw = b"".join(b"\x00" + arr[y].tobytes() for y in range(h))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    OUT.mkdir(exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    pngs = {s: png(render(s)) for s in sizes}
    (OUT / "icon.png").write_bytes(pngs[256])        # window and taskbar
    (OUT / "icon_32.png").write_bytes(pngs[32])      # tray (drawn specially for small sizes)
    (OUT / "icon_128.png").write_bytes(pngs[128])
    (OUT / "icon_512.png").write_bytes(png(render(512)))
    entries, blobs = b"", b""
    offset = 6 + 16 * len(sizes)
    for s in sizes:
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(pngs[s]), offset)
        offset += len(pngs[s])
        blobs += pngs[s]
    (OUT / "icon.ico").write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) + entries + blobs)
    print("wrote", ", ".join(p.name for p in sorted(OUT.glob("icon*"))))


if __name__ == "__main__":
    main()
