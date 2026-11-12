#!/usr/bin/env python3
"""Regenerate the starfield fixture for test-planet.js.

The JS fidelity check vs lifecycle.py is RETIRED (Nov 11): the JS renderer
is the look authority now and intentionally diverges from the Python loop
(higher resolution, limb fade, softer light). test-fixtures/compare-grids.json
is stale and unused — do not regenerate it.

What this still does: test-fixtures/stars.json — the 80-star field for the
136x76 grid, same seed-42 formula the Python loop used for its 100x48 field
(random.seed(42); x in [0,W), y in [0,H), speed in [0.5,2.0), char in ".*+").
Run:  python3 dump-compare.py
"""
import json
import os
import random

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test-fixtures')
os.makedirs(OUT, exist_ok=True)

random.seed(42)
W, H = 136, 76
stars = [[random.randint(0, W - 1), random.randint(0, H - 1),
          random.uniform(0.5, 2.0), random.choice('.*+')] for _ in range(80)]

with open(os.path.join(OUT, 'stars.json'), 'w') as f:
    json.dump(stars, f)

print(f'wrote {len(stars)} stars to {OUT}')
