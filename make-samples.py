#!/usr/bin/env python3
"""Draw sample planet grids (JSON from dump-samples.js) as PNG stills.
Reuses the ANSI->RGB + grid drawing from capture_frames.py.
Usage: node dump-samples.js samples-seeds.json > /tmp/sample-grids.json
       python3 make-samples.py
Outputs: vscode-extension/samples/*.png
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
SAMPLES_DIR = os.path.join(BASE, 'samples')
FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'

STD16 = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
    (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]


def ansi256_to_rgb(code):
    if code is None:
        return (0, 0, 0)
    if code < 16:
        return STD16[code]
    if code < 232:
        n = code - 16
        r, g, b = (n // 36) % 6, (n // 6) % 6, n % 6
        f = lambda v: 0 if v == 0 else 55 + 40 * v
        return (f(r), f(g), f(b))
    v = 8 + 10 * (code - 232)
    return (v, v, v)


def grid_to_image(grid, title, desc, cell_w=10, cell_h=18,
                  font_size=15, header_h=56):
    h, w = len(grid), len(grid[0])
    img = Image.new('RGB', (w * cell_w, h * cell_h + header_h), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, font_size)
    header_font = ImageFont.truetype(FONT_PATH, 17)
    draw.text((8, 6), title, fill=(229, 229, 229), font=header_font)
    draw.text((8, 30), desc, fill=(160, 160, 160), font=font)
    for y, row in enumerate(grid):
        for x, (ch, col) in enumerate(row):
            if ch == ' ':
                continue
            draw.text((x * cell_w + 1, header_h + y * cell_h + 1), ch,
                      fill=ansi256_to_rgb(col), font=font)
    return img


def main():
    with open('/tmp/sample-grids.json') as f:
        items = json.load(f)
    os.makedirs(SAMPLES_DIR, exist_ok=True)
    for it in items:
        name = f"seed-{it['seed']}-{it['tag']}.png"
        title = f"Seed {it['seed']} · {it['stage']} — {it['terrain']}"
        grid_to_image(it['grid'], title, it['summary']).save(
            os.path.join(SAMPLES_DIR, name))
        print(f'wrote {name}')


if __name__ == '__main__':
    main()
