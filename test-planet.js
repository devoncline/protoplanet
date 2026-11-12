// test-planet.js — verification for Piece 1 (restyled Nov 11).
// Run: node test-planet.js
// Checks:
//   1. Determinism: same seed -> same planet; same render -> identical grid.
//   2. Variety: 500 seeds cover every terrain, ring type and moon count.
//   3. Starfield: JS STARS match the checked-in fixture (regenerated for
//      the 136x76 grid — see test-fixtures/stars.json).
//   4. Roundness + disc size: the rendered disc displays as a circle
//      (ratio near the approved ~1.11) and is bigger than the old
//      100x48 disc (38 cells wide).
//  14. Mutations (piece 3): determinism, distribution, base rarity,
//      labels, unlock gating, and one render check per mutation effect
//      (carrier seed vs its plain twin) — incl. Crystal vs Glitch.
//  18. Solar-system disc rules (Devon, Nov 12): stage-driven scale,
//      noStars flag, ringFitZoom (verified empirically: rings vs
//      rings-stripped diff never touches the disc border).
//  19. Zoom detail (Devon, Nov 12): discDetail tiers (23x16 → 46x31 →
//      136x76 at zoom/fit ratios 2 and 3), DOM size constant across
//      tiers, same planet at every tier (downsample identity), more
//      non-blank cells at denser tiers, ring fit conservative at the
//      top tier.
//   The old fidelity check vs lifecycle.py is RETIRED by design: the JS
//   renderer is the look authority now and intentionally diverges from
//   the Python loop (higher resolution, limb fade, softer light). Do not
//   re-add a cell-for-cell fidelity check — the two are supposed to
//   differ. test-fixtures/compare-grids.json is stale and unused.
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./planet.js');

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}
function gridsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x][0] !== b[y][x][0] || a[y][x][1] !== b[y][x][1]) return false;
    }
  }
  return true;
}

// --- 1. Determinism -------------------------------------------------------
const p1 = P.generatePlanet(4821);
const p2 = P.generatePlanet(4821);
check('same seed -> same planet', JSON.stringify(p1) === JSON.stringify(p2));
const g1 = P.render(p1, 6, 5.0, 3.0);
const g2 = P.render(p2, 6, 5.0, 3.0);
check('same seed+stage+time -> identical grid', gridsEqual(g1, g2));
const p3 = P.generatePlanet(4822);
check('different seed -> different planet', JSON.stringify(p1) !== JSON.stringify(p3));

// Starter pick guarantees the terrain (Devon, Nov 11): 200 rolls with
// starter 'icy' are all icy. The rng draw is still consumed, so the
// other traits stay identical for a seed.
let icyCount = 0;
for (let s = 0; s < 200; s++) {
  if (P.generatePlanet(s, 'icy').terrain === 'icy') icyCount++;
}
check('starter pick guarantees the terrain (200/200 icy)', icyCount === 200, `${icyCount}/200 icy`);

// --- 2. Variety ------------------------------------------------------------
const seenTerrain = new Set(), seenRing = new Set(), seenMoons = new Set();
for (let s = 0; s < 500; s++) {
  const p = P.generatePlanet(s);
  seenTerrain.add(p.terrain); seenRing.add(p.ringType); seenMoons.add(p.moons.length);
}
check('500 seeds cover all 10 terrains', seenTerrain.size === 10, `${seenTerrain.size}/10: ${[...seenTerrain].join(',')}`);
check('500 seeds cover all 6 ring types', seenRing.size === 6, `${seenRing.size}/6: ${[...seenRing].join(',')}`);
check('500 seeds cover moon counts 0-3', seenMoons.size === 4, `${seenMoons.size}/4: ${[...seenMoons].join(',')}`);

// --- 3. Starfield matches the checked-in fixture ---------------------------
// Fixtures live in test-fixtures/ (checked in — /tmp kept getting wiped).
const pyStars = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixtures', 'stars.json'), 'utf8'));
check('JS STARS match the fixture exactly', JSON.stringify(P.STARS) === JSON.stringify(pyStars),
  `${P.STARS.length} vs ${pyStars.length} stars`);
check('starfield covers the 136x76 grid', P.STARS.every(([x, y]) => x >= 0 && x < 136 && y >= 0 && y < 76));

// --- 4. Roundness + disc size (the look check) -----------------------------
// Ringless, moonless test planet so the only non-blank cells are the disc
// (stars excluded by coordinate — a disc cell always has a color, even
// when its glyph is the blank first ramp char).
const roundPlanet = {
  seed: -1, terrain: 'icy', terrainLabel: 'Icy', bands: [159, 123, 45],
  atmosphere: 250, ringType: 'none', ringLabel: 'No rings', moons: [], size: 1.0,
  summary: 'test planet',
};
const starSet = new Set(P.STARS.map(([sx, sy]) => sx + ',' + sy));
function discExtent(planet, stageIdx, t, sec) {
  const g = P.render(planet, stageIdx, t, sec);
  let minX = 9999, maxX = -1, minY = 9999, maxY = -1, n = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      if (g[y][x][1] !== null && !starSet.has(x + ',' + y)) {
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const w = (maxX - minX + 1) * P.CONFIG.CELL_W;
  const h = (maxY - minY + 1) * P.CONFIG.CELL_H;
  return { n, cols: maxX - minX + 1, rows: maxY - minY + 1, ratio: w / h };
}
for (const [stageIdx, label] of [[6, 'Civilization'], [4, 'Oceans']]) {
  const d = discExtent(roundPlanet, stageIdx, 5.0, 3.0);
  check(`${label} disc displays round (ratio 0.95-1.20)`, d.ratio >= 0.95 && d.ratio <= 1.20,
    `ratio ${d.ratio.toFixed(3)} (${d.cols}x${d.rows} cells)`);
  check(`${label} disc is bigger than the old 100x48 disc`, d.cols >= 50,
    `${d.cols} cells wide (was 38), ${d.n} filled cells`);
}

// --- 5. Round-2 shading: the sphere reads 3D, colors stay saturated -----
// The glyphs and the color luminance must fall off smoothly from the lit
// top-left to the dark bottom-right (the reel's shading style), while
// the terrain colors stay saturated (Devon's correction, Nov 11: keep
// our colors — never wash them down).
function discLuminance(planet, stageIdx, t, sec) {
  const g = P.render(planet, stageIdx, t, sec);
  const tl = [], br = []; // top-left vs bottom-right disc quadrants
  let satSum = 0, satMax = 0, n = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const [ch, col] = g[y][x];
      if (col === null || starSet.has(x + ',' + y)) continue;
      const [r, gg, b] = P.ansi256ToRgb(col);
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const sat = Math.max(r, gg, b) - Math.min(r, gg, b);
      satSum += sat; if (sat > satMax) satMax = sat; n++;
      if (x < P.CONFIG.CX && y < P.CONFIG.CY) tl.push(lum);
      else if (x > P.CONFIG.CX && y > P.CONFIG.CY) br.push(lum);
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { tl: mean(tl), br: mean(br), meanSat: satSum / n, maxSat: satMax, n };
}
const shade = discLuminance(roundPlanet, 6, 5.0, 3.0);
check('lit top-left is brighter than dark bottom-right', shade.tl > shade.br * 1.25,
  `top-left ${shade.tl.toFixed(1)} vs bottom-right ${shade.br.toFixed(1)} (ratio ${(shade.tl / shade.br).toFixed(2)})`);
// Mean saturation 25 is still far above a washed-out render (~5, the
// reverted monochrome direction). It reads lower than round 2's 34.7
// because the old city-light blocks were ~30 cells of full-saturation
// 226 yellow inflating the mean — the terrain colors themselves did
// not change.
check('terrain colors stay saturated (not washed out)', shade.meanSat > 25 && shade.maxSat > 100,
  `mean saturation ${shade.meanSat.toFixed(1)}, max ${shade.maxSat}`);

// --- 6. Render smoke: every stage renders without throwing -----------------
for (let i = 0; i < P.STAGES.length; i++) {
  const p = P.generatePlanet(100 + i);
  const g = P.render(p, i, P.STAGES[i].dur * 0.5, 2.0);
  const filled = g.flat().filter(([ch]) => ch !== ' ').length;
  if (filled < 50) { check(`stage ${P.STAGES[i].name} renders content`, false, `${filled} cells`); }
}
console.log('PASS  all stages render content');

// --- 7. Texture motion (Nov 11): continents are seeded + organic, and the
// whole surface rotates together in one drifting texture coordinate.
// Pre-fix, the Life green mask was the stage sine lattice: identical for
// every seed (IoU 1.000) and a hard-edged grid block. The belt/waves were
// sampled in screen space, so the dark bands stood still (98.6% overlap
// at dx=0 between frames 2s apart) while the terrain drifted.
function oceanTestPlanet(seed) {
  return { seed, terrain: 'test', terrainLabel: 'Test', bands: [27, 33, 39],
    atmosphere: 250, ringType: 'none', ringLabel: 'No rings', moons: [], size: 1.0, summary: 'test' };
}
function isGreenCell(col) {
  const [r, g, b] = P.ansi256ToRgb(col);
  return g > r + 30 && g > b + 20;
}
function greenMask(planet, stageIdx, t, sec, litQuad) {
  const g = P.render(planet, stageIdx, t, sec);
  const s = new Set();
  const x1 = litQuad ? P.CONFIG.CX : P.CONFIG.W, y1 = litQuad ? P.CONFIG.CY : P.CONFIG.H;
  for (let y = 0; y < y1; y++) for (let x = 0; x < x1; x++) {
    if (g[y][x][1] !== null && !starSet.has(x + ',' + y) && isGreenCell(g[y][x][1])) s.add(x + ',' + y);
  }
  return s;
}
function maskIoU(a, b) {
  let inter = 0; for (const k of a) if (b.has(k)) inter++;
  return inter / (a.size + b.size - inter);
}
function maskOverlapAt(a, b, dx) {
  let ov = 0;
  for (const k of a) { const i = k.indexOf(','); if (b.has((+k.slice(0, i) + dx) + ',' + k.slice(i + 1))) ov++; }
  return ov / Math.max(1, a.size);
}
function bestShiftDx(a, b, range) {
  let best = { dx: 0, frac: 0 };
  for (let dx = -range; dx <= range; dx++) { const f = maskOverlapAt(a, b, dx); if (f > best.frac) best = { dx, frac: f }; }
  return best;
}
const gmA = greenMask(oceanTestPlanet(1), 5, 5.0, 3.0, false);
const gmB = greenMask(oceanTestPlanet(2), 5, 5.0, 3.0, false);
const gmC = greenMask(oceanTestPlanet(999), 5, 5.0, 3.0, false);
check('green continents differ across seeds (IoU < 0.5)',
  maskIoU(gmA, gmB) < 0.5 && maskIoU(gmA, gmC) < 0.5,
  `IoU 1v2 ${maskIoU(gmA, gmB).toFixed(3)}, 1v999 ${maskIoU(gmA, gmC).toFixed(3)} (was 1.000)`);
check('every seed grows land (green cells present)',
  gmA.size > 10 && gmB.size > 10 && gmC.size > 10,
  `${gmA.size}/${gmB.size}/${gmC.size} green cells`);
const gq0 = greenMask(oceanTestPlanet(7), 5, 5.0, 0.0, true);
const gq2 = greenMask(oceanTestPlanet(7), 5, 5.0, 2.0, true);
const gDrift = bestShiftDx(gq0, gq2, 40);
check('green drifts right at the spin rate (+17 cells per 2s)',
  gDrift.dx >= 14 && gDrift.dx <= 20 && gDrift.frac > 0.3 && maskOverlapAt(gq0, gq2, 0) < gDrift.frac,
  `best shift +${gDrift.dx} cells, overlap ${gDrift.frac.toFixed(2)} (unshifted ${maskOverlapAt(gq0, gq2, 0).toFixed(2)})`);
// The continent field wraps with the texture period: one full turn = 4
// radius units, so the field at u and u+4 is the same field (within one
// floating-point ULP of rounding noise from the wrap).
check('continent field is periodic in longitude (period 4)',
  Math.abs(P.continentField(0.3, 0.2, 42) - P.continentField(4.3, 0.2, 42)) < 1e-9
  && Math.abs(P.continentField(-1.7, -0.4, 42) - P.continentField(2.3, -0.4, 42)) < 1e-9);
check('continent field differs across seeds',
  P.continentField(0.3, 0.2, 42) !== P.continentField(0.3, 0.2, 43));

// --- 8. Overnight list (Nov 11): city-light sparkles, ring tilt,
// 3D moons, cozy readability. (Night-side floor: PAUSED by Devon —
// not implemented, not tested.)
// --- 8a. City lights are sparkles, not identical yellow blocks -------
const SPARKLE_COLORS = new Set([229, 230, 222]);
const SPARKLE_CHARS = new Set(['.', '*', '+']);
function cityCells(planet, stageIdx, t, sec) {
  const g = P.render(planet, stageIdx, t, sec);
  const s = new Set();
  const r = 28.5 * (planet.size || 1.0); // Civ stage radius
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      if (starSet.has(x + ',' + y)) continue;
      const [ch, col] = g[y][x];
      if (col === null || !SPARKLE_COLORS.has(col) || !SPARKLE_CHARS.has(ch)) continue;
      const ddx = (x - P.CONFIG.CX) / r, ddy = (y - P.CONFIG.CY) / r;
      if (ddx * ddx + Math.pow(2 * ddy, 2) <= 1.0) s.add(x + ',' + y);
    }
  }
  return s;
}
function countBlocks(planet, stageIdx, t, sec) {
  // The OLD city lights: '#' glyph in full 226 yellow. Must be gone.
  const g = P.render(planet, stageIdx, t, sec);
  let n = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      if (g[y][x][0] === '#' && g[y][x][1] === 226) n++;
    }
  }
  return n;
}
// Ringless test planet so no ring gold can masquerade as a sparkle.
const cityPlanet = { ...roundPlanet, ringType: 'none', ringLabel: 'No rings' };
check('no old yellow city-light blocks in Civilization',
  countBlocks(cityPlanet, 6, 5.0, 3.0) === 0,
  `${countBlocks(cityPlanet, 6, 5.0, 3.0)} '#' 226 cells`);
const sp0 = cityCells(cityPlanet, 6, 5.0, 0.0);
const sp2 = cityCells(cityPlanet, 6, 5.0, 2.0);
const spTurn = cityCells(cityPlanet, 6, 5.0, 13.33); // one full texture turn (4 / 0.30)
check('city sparkles exist on the night side', sp0.size >= 5, `${sp0.size} sparkle cells`);
check('sparkle pattern shifts as the surface rotates (2s apart)',
  maskOverlapAt(sp0, sp2, 0) < 0.9, `overlap ${maskOverlapAt(sp0, sp2, 0).toFixed(2)}`);
// After one full texture turn (4 / 0.30 = 13.33s) the lights are still
// there, but the pattern is NOT the same one: the light field is a
// sin-hash of the texture cells, which is not periodic, so each turn
// brings a fresh pattern — never the same identical pattern twice,
// which is exactly what Devon asked for.
check('sparkles persist after one full turn, with a different pattern',
  spTurn.size >= 5 && maskOverlapAt(sp0, spTurn, 0) < 0.95,
  `${spTurn.size} sparkle cells, overlap ${maskOverlapAt(sp0, spTurn, 0).toFixed(2)}`);
const spSeed2 = cityCells({ ...cityPlanet, seed: 777 }, 6, 5.0, 0.0);
check('sparkle pattern differs per planet (seeded)',
  maskIoU(sp0, spSeed2) < 0.8, `IoU ${maskIoU(sp0, spSeed2).toFixed(3)}`);

// --- 8b. Ring tilt: seeded variety, mostly flat, steep is rare --------
const tilts = [];
for (let s = 0; s < 500; s++) {
  const p = P.generatePlanet(s);
  if (p.ringType !== 'none') tilts.push(Math.abs(p.ringTilt));
}
const flatFrac = tilts.filter(t => t <= 4).length / tilts.length;
const steepFrac = tilts.filter(t => t > 20).length / tilts.length;
const distinctTilts = new Set(tilts.map(t => t.toFixed(1))).size;
check('ring tilt is bounded (<= 32 deg)',
  tilts.every(t => t <= 32.5), `max ${Math.max(...tilts).toFixed(1)} deg over ${tilts.length} ringed planets`);
check('most rings are near-flat (flat is the biggest bucket)',
  flatFrac >= 0.30, `${(flatFrac * 100).toFixed(0)}% flat`);
check('steep tilts are rare but exist',
  steepFrac >= 0.02 && steepFrac <= 0.25, `${(steepFrac * 100).toFixed(0)}% steep`);
check('tilt varies continuously across seeds',
  distinctTilts >= 50, `${distinctTilts} distinct values`);
// A steep ring actually draws tilted: its cells reach well beyond the
// flat ellipse's vertical reach (ry ~ 11 cells at full openness).
const tiltPlanet = { seed: 5, terrain: 'rocky', terrainLabel: 'Rocky', bands: [137, 130, 94],
  atmosphere: 250, ringType: 'wide', ringLabel: 'Wide ring', ringTilt: 25, ringTiltLabel: 'steep',
  moons: [], size: 1.0, summary: 'test' };
const tiltGrid = P.render(tiltPlanet, 6, 5.0, 3.0);
let maxRingDy = 0, ringCells = 0;
for (let y = 0; y < P.CONFIG.H; y++) {
  for (let x = 0; x < P.CONFIG.W; x++) {
    if (tiltGrid[y][x][1] === null || starSet.has(x + ',' + y)) continue;
    const ddx = (x - P.CONFIG.CX) / 28.5, ddy = (y - P.CONFIG.CY) / 28.5;
    if (ddx * ddx + Math.pow(2 * ddy, 2) > 1.0) { // outside the disc
      ringCells++;
      if (Math.abs(y - P.CONFIG.CY) > maxRingDy) maxRingDy = Math.abs(y - P.CONFIG.CY);
    }
  }
}
check('steep ring draws tilted (extends beyond the flat ellipse)',
  ringCells > 50 && maxRingDy > 18, `${ringCells} ring cells, max |dy| ${maxRingDy} (flat ~11)`);

// --- 8c. Moons are mini shaded spheres, not single 'o' cells ---------
// Manual 3-moon planet so the test controls every trait.
const moonPlanet = { seed: 42, terrain: 'icy', terrainLabel: 'Icy', bands: [159, 123, 45],
  atmosphere: 250, ringType: 'none', ringLabel: 'No rings', ringTilt: 0, ringTiltLabel: 'flat',
  moons: [
    { orbit: 1.7, speed: 0.3, phase: 0.4, radius: 3.0, tint: 244 },
    { orbit: 2.0, speed: -0.25, phase: 2.5, radius: 4.0, tint: 180 },
    { orbit: 2.3, speed: 0.2, phase: 4.5, radius: 2.0, tint: 153 },
  ], size: 1.0, summary: 'test' };
function moonCenter(m, sec, r) {
  const ang = m.phase + sec * m.speed;
  const ox = m.orbit * r * Math.cos(ang);
  const oy = 0.5 * m.orbit * r * Math.sin(ang);
  const tilt = (moonPlanet.ringTilt * Math.PI) / 180;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return [P.CONFIG.CX + ox * c - oy * s, P.CONFIG.CY + ox * s + oy * c];
}
function moonCells(planet, stageIdx, t, sec, moonIdx) {
  const g = P.render(planet, stageIdx, t, sec);
  const r = 28.5 * (planet.size || 1.0);
  const m = planet.moons[moonIdx];
  const [mx, my] = moonCenter(m, sec, r);
  const cells = [];
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const sx = (x - mx) / m.radius, sy = (y - my) / m.radius;
      if (sx * sx + Math.pow(2 * sy, 2) > 1.0) continue;
      const [ch, col] = g[y][x];
      if (col !== null && !starSet.has(x + ',' + y)) cells.push({ x, y, ch, col });
    }
  }
  return { cells, mx, my };
}
let moonsOk = true, moonDetail = [];
for (let i = 0; i < 3; i++) {
  const { cells, mx, my } = moonCells(moonPlanet, 6, 5.0, 0.0, i);
  const glyphs = new Set(cells.map(c => c.ch));
  const colors = new Set(cells.map(c => c.col));
  const lum = (c) => { const [r, g, b] = P.ansi256ToRgb(c.col); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const toward = cells.filter(c => (c.x - mx) + (c.y - my) < 0);
  const away = cells.filter(c => (c.x - mx) + (c.y - my) > 0);
  const mean = (a) => a.reduce((s, c) => s + lum(c), 0) / Math.max(1, a.length);
  // A moon's disc holds ~pi*r^2/2 cells (the disc is 2:1 squashed);
  // expect at least 60% of that, and enough glyph/color variety for
  // its size (the small moon has ~6 cells, so 2 glyphs is enough).
  const m = moonPlanet.moons[i];
  const expected = Math.PI * m.radius * m.radius / 2;
  const needGlyphs = m.radius >= 3.0 ? 3 : 2;
  const ok = cells.length >= expected * 0.6 && glyphs.size >= needGlyphs && colors.size >= 2
    && (toward.length === 0 || away.length === 0 || mean(toward) > mean(away));
  if (!ok) moonsOk = false;
  moonDetail.push(`moon${i}: ${cells.length} cells (expect ~${expected.toFixed(0)}), ${glyphs.size} glyphs, ${colors.size} colors, lit ${mean(toward).toFixed(0)} vs dark ${mean(away).toFixed(0)}`);
}
check('each moon is a shaded disc (many cells, several glyphs/colors, lit side brighter)',
  moonsOk, moonDetail.join(' | '));
const mc0 = moonCenter(moonPlanet.moons[0], 0.0, 28.5);
const mc3 = moonCenter(moonPlanet.moons[0], 3.0, 28.5);
check('moons move along their orbit',
  Math.hypot(mc3[0] - mc0[0], mc3[1] - mc0[1]) > 2,
  `moon 0 moved ${Math.hypot(mc3[0] - mc0[0], mc3[1] - mc0[1]).toFixed(1)} cells in 3s`);
// Generated moons carry the new traits. Radius 5.0 and tints 46/196
// exist now, but ONLY as mutation overrides: a radius-5 moon must list
// 'big-moon', a 46 moon must list 'green-moon', a 196 moon must list
// 'blood-moon' — plain moons still roll only 2/3/4 and the six base tints.
let genMoonsOk = true;
for (let s = 0; s < 200; s++) {
  const pl = P.generatePlanet(s);
  for (const m of pl.moons) {
    const okRadius = [2.0, 3.0, 4.0].includes(m.radius)
      || (m.radius === 5.0 && (m.mutantIds || []).includes('big-moon'));
    const okTint = [244, 250, 180, 153, 209, 137].includes(m.tint)
      || (m.tint === 46 && (m.mutantIds || []).includes('green-moon'))
      || (m.tint === 196 && (m.mutantIds || []).includes('blood-moon'));
    if (!okRadius || !okTint) genMoonsOk = false;
  }
}
check('generated moons have seeded radius + tint', genMoonsOk);

// --- 8d. Cozy: the downsampled render stays a readable sphere -------
const cozy = P.renderCozy(roundPlanet, 6, 5.0, 3.0);
const cozy2 = P.renderCozy(roundPlanet, 6, 5.0, 3.0);
check('renderCozy returns a 68x38 grid', cozy.length === 38 && cozy[0].length === 68,
  `${cozy[0].length}x${cozy.length}`);
check('renderCozy is deterministic',
  JSON.stringify(cozy) === JSON.stringify(cozy2));
function cozyExtent(g) {
  let minX = 9999, maxX = -1, minY = 9999, maxY = -1;
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      if (g[y][x][1] !== null) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const w = (maxX - minX + 1) * P.CONFIG.CELL_W;
  const h = (maxY - minY + 1) * P.CONFIG.CELL_H;
  return { cols: maxX - minX + 1, rows: maxY - minY + 1, ratio: w / h };
}
const ce = cozyExtent(cozyDiscOnly());
check('cozy disc displays round (ratio 0.95-1.20)', ce.ratio >= 0.95 && ce.ratio <= 1.20,
  `ratio ${ce.ratio.toFixed(3)} (${ce.cols}x${ce.rows} cells)`);
// Roundness is measured on a disc-only downsample (no starfield):
// stars average into dim dots across the whole grid and would fake
// the extent to the full grid size.
function cozyDiscOnly() {
  const discOnly = P.makeGrid();
  P.drawPlanet(discOnly, P.STAGES[6], 28.5, 3.0, roundPlanet, 1.0);
  return P.downsampleGrid(discOnly, 68, 38);
}
function gridLuminance(g) {
  const tl = [], br = [];
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      const [ch, col] = g[y][x];
      if (col === null) continue;
      const [r, gg, b] = P.ansi256ToRgb(col);
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      if (x < g[0].length / 2 && y < g.length / 2) tl.push(lum);
      else if (x > g[0].length / 2 && y > g.length / 2) br.push(lum);
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return { tl: mean(tl), br: mean(br) };
}
const cl = gridLuminance(cozy);
check('cozy keeps the shading gradient (lit top-left brighter)',
  cl.tl > cl.br * 1.25, `top-left ${cl.tl.toFixed(1)} vs bottom-right ${cl.br.toFixed(1)}`);
// Not a jumble: a cozy disc cell should look like its neighbours
// (area-averaging makes the tone smooth); a point-sampled jumble
// would have many cells wildly different from all 4 neighbours.
function jumbleFraction(g) {
  let bad = 0, n = 0;
  for (let y = 0; y < g.length; y++) {
    for (let x = 0; x < g[0].length; x++) {
      const [ch, col] = g[y][x];
      if (col === null) continue;
      const [r, gg, b] = P.ansi256ToRgb(col);
      const nb = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g[0].length || ny >= g.length) continue;
        if (g[ny][nx][1] === null) continue;
        const [nr, ng, nbl] = P.ansi256ToRgb(g[ny][nx][1]);
        nb.push([nr, ng, nbl]);
      }
      if (!nb.length) continue;
      n++;
      const mr = nb.reduce((s, v) => s + v[0], 0) / nb.length;
      const mg = nb.reduce((s, v) => s + v[1], 0) / nb.length;
      const mb = nb.reduce((s, v) => s + v[2], 0) / nb.length;
      if (Math.hypot(r - mr, gg - mg, b - mb) > 100) bad++;
    }
  }
  return bad / Math.max(1, n);
}
check('cozy is smooth, not a color jumble (< 15% outlier cells)',
  jumbleFraction(cozy) < 0.15, `${(jumbleFraction(cozy) * 100).toFixed(1)}% outlier cells`);

// --- 8e. No Civilization satellite (removed Nov 11) ----------------------
// Devon first asked for the satellite restyled as a 3D sphere, then
// decided the same night: no satellites at all ("I actually don't
// think we need satellites"). The `if (st.mode === 'civ')` satellite
// block is deleted from render(); this checks nothing orbits there
// anymore. cityPlanet is ringless and moonless, so outside the disc
// the only legal cells are stars — any other non-blank cell out there
// would be a leftover orbiter.
function outsideDiscNonStarCells(planet, sec) {
  const g = P.render(planet, 6, 5.0, sec);
  const r = 28.5 * (planet.size || 1.0); // Civ stage radius
  let n = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const [ch, col] = g[y][x];
      if (col === null || starSet.has(x + ',' + y)) continue;
      const ddx = (x - P.CONFIG.CX) / r, ddy = (y - P.CONFIG.CY) / r;
      if (ddx * ddx + Math.pow(2 * ddy, 2) > 1.0) n++;
    }
  }
  return n;
}
let satGoneOk = true, satGoneDetail = [];
for (const sec of [0.0, 2.0, 4.0]) {
  const n = outsideDiscNonStarCells(cityPlanet, sec);
  if (n !== 0) satGoneOk = false;
  satGoneDetail.push(`sec ${sec}: ${n} non-star cells outside the disc`);
}
check('no satellite in Civilization (nothing orbits outside the disc)',
  satGoneOk, satGoneDetail.join(' | '));
// The old artifact: a single ['o', 255] cell. Nothing in the renderer
// may draw that anymore (ocean speckles use 'o' too, but only ON the
// disc and never in 255 white).
let bareO = 0;
for (let s = 0; s < 50; s++) {
  const p = P.generatePlanet(s);
  for (const sec of [0.0, 2.0, 4.0]) {
    const g = P.render(p, 6, 5.0, sec);
    for (let y = 0; y < P.CONFIG.H; y++) {
      for (let x = 0; x < P.CONFIG.W; x++) {
        if (g[y][x][0] === 'o' && g[y][x][1] === 255) bareO++;
      }
    }
  }
}
check('no bare white \'o\' cells in any Civilization render (50 seeds x 3 times)',
  bareO === 0, `${bareO} ['o', 255] cells`);

// --- 9. Crust lava cracks are shaded fractures, not a flat lattice -----
// Devon (Nov 11): the old cracks looked like a "chain link fence"
// sliding over the planet — uniformly bright orange everywhere,
// including the night side, on a regular sine lattice. Now the cracks
// are shaded by the same brightness field as the surface (hot and
// bright on the lit side, ember-dim on the night side) and wobbled by
// seeded noise so the lattice breaks into organic fractures.
// A jungle planet is the clean probe: its bands are green, so every
// warm cell in the disc IS a crack.
function warmCellsInDisc(planet, stageIdx, t, sec) {
  const g = P.render(planet, stageIdx, t, sec);
  const r = 24.0 * (planet.size || 1.0); // Crust radius
  const warm = new Set();
  let litSum = 0, litN = 0, nightSum = 0, nightN = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const [ch, col] = g[y][x];
      if (col === null) continue;
      const ddx = (x - P.CONFIG.CX) / r, ddy = (y - P.CONFIG.CY) / r;
      if (ddx * ddx + Math.pow(2 * ddy, 2) > 1.0) continue;
      const [rr, gg, bb] = P.ansi256ToRgb(col);
      if (!(rr >= gg + 10 && rr >= bb + 10)) continue;
      const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
      warm.add(x + ',' + y);
      if (x < P.CONFIG.CX) { litSum += L; litN++; } else { nightSum += L; nightN++; }
    }
  }
  return { warm, litMean: litN ? litSum / litN : 0, nightMean: nightN ? nightSum / nightN : 0,
    ratio: litN && nightN ? (nightSum / nightN) / (litSum / litN) : 1 };
}
const crustPlanet = P.generatePlanet(161675658); // Devon's jungle planet
const cw0 = warmCellsInDisc(crustPlanet, 3, 3.5, 0.0);
const cw2 = warmCellsInDisc(crustPlanet, 3, 3.5, 2.0);
const cw4 = warmCellsInDisc(crustPlanet, 3, 3.5, 4.0);
const worstRatio = Math.max(cw0.ratio, cw2.ratio, cw4.ratio);
const worstNight = Math.max(cw0.nightMean, cw2.nightMean, cw4.nightMean);
check('crust cracks are shaded: night side dimmer than lit side (ratio < 0.85; old code was exactly 1.000)',
  worstRatio < 0.85, `worst ratio ${worstRatio.toFixed(3)}`);
check('crust cracks are ember-dim on the night side (night mean < 70; old code was 132)',
  worstNight < 70, `worst night mean ${worstNight.toFixed(1)}`);
check('cracks still exist (warm cells present at every time)',
  cw0.warm.size >= 10 && cw2.warm.size >= 10 && cw4.warm.size >= 10,
  `${cw0.warm.size}/${cw2.warm.size}/${cw4.warm.size} warm cells`);
// The cracks drift with the surface (texture space): the warm mask at
// sec 2 is NOT the sec-0 mask — it moved.
check('cracks rotate with the surface (warm mask shifts in 2s)',
  maskIoU(cw0.warm, cw2.warm) < 0.9, `IoU ${maskIoU(cw0.warm, cw2.warm).toFixed(2)}`);

// --- 10. Stage-0 looks: nebula + exploded (Nov 11) ----------------------
// Devon picked two first-stage options to compare: a glowing nebula
// (dense swirl pulling together) and an exploded planet (molten core +
// fragments flying out). Both live behind the `stage0Style` flag
// ('dust' | 'nebula' | 'exploded'); the default (no flag) is now the
// exploded look — Devon picked it as the winner (Nov 11, 9:26 AM).
function stage0Stats(planet, style, sec) {
  const g = P.render(planet, 0, 4.0, sec, 1.0, style);
  const r = 18.0 * (planet.size || 1.0);
  const stars = new Set();
  for (const [sx, sy, sp] of P.STARS) {
    const tw = 0.5 + 0.5 * Math.sin(sec * 2.0 + sp * 3.0);
    if (tw > 0.25) stars.add(sx + ',' + sy);
  }
  const cells = new Set();
  let sum = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const [ch, col] = g[y][x];
      if (col === null || stars.has(x + ',' + y)) continue;
      const ddx = (x - P.CONFIG.CX) / r, ddy = (y - P.CONFIG.CY) / r;
      if (Math.sqrt(ddx * ddx + Math.pow(2 * ddy, 2)) > 2.1) continue;
      const [rr, gg, bb] = P.ansi256ToRgb(col);
      cells.add(x + ',' + y);
      sum += 0.299 * rr + 0.587 * gg + 0.114 * bb;
    }
  }
  return { cells, totalLight: sum };
}
const s0Planet = P.generatePlanet(161675658);
const d2 = stage0Stats(s0Planet, 'dust', 2.0);
const n2 = stage0Stats(s0Planet, 'nebula', 2.0);
const n0 = stage0Stats(s0Planet, 'nebula', 0.0);
check('nebula is much denser than the old dust sprinkle (>= 2x cells)',
  n2.cells.size >= 2 * d2.cells.size, `${n2.cells.size} vs ${d2.cells.size} cells`);
check('nebula is much brighter than the old dust sprinkle (>= 1.8x total light)',
  n2.totalLight >= 1.8 * d2.totalLight, `${(n2.totalLight / 1000).toFixed(1)}k vs ${(d2.totalLight / 1000).toFixed(1)}k`);
check('nebula swirls: the mask moves between frames, count stays stable',
  maskIoU(n0.cells, n2.cells) < 0.6 && n2.cells.size > 0.75 * n0.cells.size && n2.cells.size < 1.25 * n0.cells.size,
  `IoU 0-2s ${maskIoU(n0.cells, n2.cells).toFixed(2)}, count ${n0.cells.size} -> ${n2.cells.size}`);
// Exploded: fragments fly outward — most fragments are farther out at
// sec 2 than at sec 0 (those that wrapped are the exception).
const frags = P.buildFragments(s0Planet.seed);
function fragRad(f, sec) { return f.base + (((sec * f.speed + f.phase) % 1.1) + 1.1) % 1.1; }
let outward = 0;
for (const f of frags) if (fragRad(f, 2.0) > fragRad(f, 0.0)) outward++;
check('exploded fragments fly outward (most fragments farther out at sec 2)',
  outward >= 10, `${outward}/14 fragments farther out`);
function coreMeanLum(planet, style, sec) {
  const g = P.render(planet, 0, 4.0, sec, 1.0, style);
  const r = 18.0 * (planet.size || 1.0);
  let sum = 0, n = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const [ch, col] = g[y][x];
      if (col === null) continue;
      const ddx = (x - P.CONFIG.CX) / r, ddy = (y - P.CONFIG.CY) / r;
      if (Math.sqrt(ddx * ddx + Math.pow(2 * ddy, 2)) > 0.6) continue;
      const [rr, gg, bb] = P.ansi256ToRgb(col);
      sum += 0.299 * rr + 0.587 * gg + 0.114 * bb; n++;
    }
  }
  return n ? sum / n : 0;
}
const coreLum = coreMeanLum(s0Planet, 'exploded', 2.0);
check('exploded core is bright (molten, mean lum > 80)',
  coreLum > 80, `core mean lum ${coreLum.toFixed(1)}`);
function cozyStats(planet, style) {
  const g = P.renderCozy(planet, 0, 4.0, 2.0, 1.0, 68, 38, style);
  let n = 0, sum = 0;
  for (let y = 0; y < 38; y++) {
    for (let x = 0; x < 68; x++) {
      const [ch, col] = g[y][x];
      if (col === null) continue;
      const [rr, gg, bb] = P.ansi256ToRgb(col);
      n++; sum += 0.299 * rr + 0.587 * gg + 0.114 * bb;
    }
  }
  return { n, totalLight: sum };
}
const cd = cozyStats(s0Planet, 'dust');
const cn = cozyStats(s0Planet, 'nebula');
check('nebula reads at Cozy size (denser + brighter than dust)',
  cn.n >= 1.3 * cd.n && cn.totalLight >= 1.5 * cd.totalLight,
  `${cn.n} cells / ${(cn.totalLight / 1000).toFixed(1)}k vs ${cd.n} / ${(cd.totalLight / 1000).toFixed(1)}k`);
check('default stage-0 is the exploded look (no flag === "exploded")',
  gridsEqual(P.render(s0Planet, 0, 4.0, 2.0), P.render(s0Planet, 0, 4.0, 2.0, 1.0, 'exploded')));
check('stage-0 styles are registered (dust/nebula/exploded with names)',
  ['dust', 'nebula', 'exploded'].every(s => P.STAGE0_STYLES[s] && P.STAGE0_STYLES[s].name),
  Object.keys(P.STAGE0_STYLES).join(', '));
check('STAGES[0] is the winner: Shattered birth',
  P.STAGES[0].name === 'Shattered birth', P.STAGES[0].name);

// --- 11. Shattered birth has the life Devon asked for (Nov 11) ---------
// No hot spot on the core (Devon: it read as a separate object off to
// the side — the core stays in the center). Ring: fragments orbit +
// a brightness wave travels around it, and the mutation colors BLEND
// into each other along the ring (no solid single-color blocks). The
// core pulses (~3.5s cycle, gentle whole-disc breathe). Smoke RADIATES outward from the core in
// all directions and fades into space. Multicolor sparkles burst out
// of the core and the ring carries mutation hues.
// Ring colors blend (Nov 11): blendHue flows between two hues, so a
// fragment's cells are a gradient toward its neighbor's tint, not one
// solid block. Unit check on the helper itself.
check('blendHue flows between hues (midpoint is neither endpoint)',
  (() => {
    const mid = P.blendHue(202, 51, 0.5);
    const [mr, mg, mb] = P.ansi256ToRgb(mid);
    const [ar, ag, ab] = P.ansi256ToRgb(202);
    const [br, bg, bb] = P.ansi256ToRgb(51);
    return mr > Math.min(ar, br) + 20 && mr < Math.max(ar, br) - 20
      && mg > Math.min(ag, bg) + 20 && mg < Math.max(ag, bg) - 20;
  })(), 'blendHue(202, 51, 0.5)');
// No bright spot anywhere in the stage-0 exploded look (Devon, Nov 11:
// the white-hot 231 spot read as a separate object, not the core).
function has231(planet, sec) {
  const g = P.render(planet, 0, 4.0, sec, 1.0, 'exploded');
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      if (g[y][x][1] === 231) return true;
    }
  }
  return false;
}
check('no bright spot: no 231 cells in the exploded look',
  !has231(s0Planet, 0.0) && !has231(s0Planet, 2.0) && !has231(s0Planet, 4.0),
  '231 present at some timestamp');
const lumPeak = coreMeanLum(s0Planet, 'exploded', 0.875);
const lumTrough = coreMeanLum(s0Planet, 'exploded', 2.625);
check('core glow pulses gently (mean lum swings peak to trough, 3.5s cycle)',
  lumPeak - lumTrough > 10, `peak ${lumPeak.toFixed(1)} vs trough ${lumTrough.toFixed(1)}`);
// Annulus analysis: everything outside the core, excluding stars.
function annulusCellsAt(planet, sec) {
  const g = P.render(planet, 0, 4.0, sec, 1.0, 'exploded');
  const r = 18.0 * (planet.size || 1.0);
  const stars = new Set();
  for (const [sx, sy, sp] of P.STARS) {
    const tw = 0.5 + 0.5 * Math.sin(sec * 2.0 + sp * 3.0);
    if (tw > 0.25) stars.add(sx + ',' + sy);
  }
  const cells = [];
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const [ch, col] = g[y][x];
      if (col === null || stars.has(x + ',' + y)) continue;
      const ddx = (x - P.CONFIG.CX) / r, ddy = (y - P.CONFIG.CY) / r;
      const radN = Math.sqrt(ddx * ddx + Math.pow(2 * ddy, 2));
      if (radN <= 0.9 || radN > 2.0) continue;
      const [rr, gg, bb] = P.ansi256ToRgb(col);
      cells.push({ x, y, ch, L: 0.299 * rr + 0.587 * gg + 0.114 * bb, rr, gg, bb });
    }
  }
  return cells;
}
const an0 = annulusCellsAt(s0Planet, 0.0);
const an2 = annulusCellsAt(s0Planet, 2.0);
const anMask0 = new Set(an0.map(c => c.x + ',' + c.y));
const anMask2 = new Set(an2.map(c => c.x + ',' + c.y));
check('debris ring moves (annulus mask shifts in 2s)',
  maskIoU(anMask0, anMask2) < 0.6, `IoU ${maskIoU(anMask0, anMask2).toFixed(2)}`);
const mut2 = an2.filter(c => c.bb > c.rr + 30 || c.gg > c.rr + 30);
check('mutation colors in the ring (iridescent fragments/sparkles present)',
  mut2.length >= 5, `${mut2.length} mutation-colored cells`);
const smoke2 = an2.filter(c => {
  const spread = Math.max(c.rr, c.gg, c.bb) - Math.min(c.rr, c.gg, c.bb);
  return spread < 20 && c.L >= 15 && c.L <= 90;
});
// Radial smoke (Nov 11): the wisps leave the core in every direction,
// so dim grey cells show up in all four quadrants around it — not a
// chimney on top, not a random halo.
const smokeQuads = new Set(smoke2.map(c =>
  (c.x >= P.CONFIG.CX ? 'E' : 'W') + (c.y >= P.CONFIG.CY ? 'S' : 'N')));
check('smoke radiates in all directions (dim grey cells in >= 3 quadrants)',
  smoke2.length >= 8 && smokeQuads.size >= 3,
  `${smoke2.length} smoke cells in ${smokeQuads.size} quadrants`);
const mutMask0 = new Set(an0.filter(c => c.bb > c.rr + 30 || c.gg > c.rr + 30).map(c => c.x + ',' + c.y));
const mutMask1 = new Set(annulusCellsAt(s0Planet, 1.0).filter(c => c.bb > c.rr + 30 || c.gg > c.rr + 30).map(c => c.x + ',' + c.y));
check('mutation sparkles twinkle/move (mask changes in 1s)',
  maskIoU(mutMask0, mutMask1) < 0.9, `IoU ${maskIoU(mutMask0, mutMask1).toFixed(2)}`);

// --- 12. Smoke redesign (Nov 11): plumes from the sphere, depth-aware,
// fast, soft grey haze — Devon: the old wisps looked like the ring
// slowly breaking off, not smoke from the sphere. ----------------------
// 20 small plumes (not 12 big blobs), each with a far/near depth side.
const smokeWisps = P.buildSmoke(s0Planet.seed);
check('smoke: 20 small plumes, each with a far/near depth side',
  smokeWisps.length === 20 && smokeWisps.every(p => p.far === (Math.sin(p.ang) < 0)),
  `${smokeWisps.length} wisps, ${smokeWisps.filter(p => p.far).length} far / ${smokeWisps.filter(p => !p.far).length} near`);
check('smoke is fast: every wisp grows at >= 0.30 cycles/sec (old max was 0.25)',
  smokeWisps.every(p => p.speed >= 0.30 && p.speed <= 0.55),
  `speeds ${Math.min(...smokeWisps.map(p => p.speed)).toFixed(2)}-${Math.max(...smokeWisps.map(p => p.speed)).toFixed(2)}`);
// The smoke pattern turns over almost completely in 1s — the burst
// sheds smoke energetically, not a slow leak.
function smokeMask(sec) {
  return new Set(annulusCellsAt(s0Planet, sec).filter(c => {
    const spread = Math.max(c.rr, c.gg, c.bb) - Math.min(c.rr, c.gg, c.bb);
    return spread < 20 && c.L >= 15 && c.L <= 90;
  }).map(c => c.x + ',' + c.y));
}
check('smoke moves fast: smoke mask IoU 0->1s is low',
  maskIoU(smokeMask(0.0), smokeMask(1.0)) < 0.3,
  `IoU ${maskIoU(smokeMask(0.0), smokeMask(1.0)).toFixed(2)}`);
// Smoke originates at the core: plenty of dim grey smoke cells in the
// band just outside the halo (radN 0.9-1.2), not only out at the ring.
const s0r = 18.0 * (s0Planet.size || 1.0);
const nearCoreSmoke = annulusCellsAt(s0Planet, 2.0).filter(c => {
  const spread = Math.max(c.rr, c.gg, c.bb) - Math.min(c.rr, c.gg, c.bb);
  const radN = Math.sqrt(Math.pow((c.x - P.CONFIG.CX) / s0r, 2) + Math.pow(2 * (c.y - P.CONFIG.CY) / s0r, 2));
  return spread < 20 && c.L >= 15 && c.L <= 90 && radN <= 1.2;
});
check('smoke starts at the core (dim grey cells in band 0.9-1.2)',
  nearCoreSmoke.length >= 10, `${nearCoreSmoke.length} cells`);
// Every smoke cell the helper produces is soft grey haze: dim, grey,
// only the dim-end glyphs '.' and ',' — never a saturated color.
(function () {
  const smoke = P.buildSmoke(s0Planet.seed);
  let bad = 0, n = 0;
  for (let s = 0; s <= 4.001; s += 0.5) {
    for (let y = 0; y < P.CONFIG.H; y++) {
      for (let x = 0; x < P.CONFIG.W; x++) {
        const ddx = (x - P.CONFIG.CX) / s0r, ddy = (y - P.CONFIG.CY) / s0r;
        const radN = Math.sqrt(ddx * ddx + Math.pow(2 * ddy, 2));
        if (radN <= 0.6 || radN > 2.0) continue;
        const cell = P.smokeCellAt(x, y, s0r, radN, smoke, s, s0Planet.seed, null);
        if (!cell) continue;
        n++;
        const [rr, gg, bb] = P.ansi256ToRgb(cell[1]);
        const spread = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
        const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        if (spread >= 20 || L > 90 || (cell[0] !== '.' && cell[0] !== ',')) bad++;
      }
    }
  }
  check('smoke is soft grey haze (dim grey, only . and , glyphs)',
    bad === 0, `${n} smoke cells checked, ${bad} bad`);
})();
// Depth: near smoke passes IN FRONT of the ring (it overwrites
// fragment cells), far smoke passes BEHIND it (fragments overwrite
// it). Proved by exact cell match at every fragment/smoke overlap.
(function () {
  const pymod = (v, n) => ((v % n) + n) % n;
  const smoke = P.buildSmoke(s0Planet.seed);
  const frags = P.buildFragments(s0Planet.seed);
  let nearTotal = 0, nearWins = 0, farTotal = 0, farWins = 0;
  for (let s = 0; s <= 4.001; s += 0.25) {
    const g = P.render(s0Planet, 0, 4.0, s, 1.0, 'exploded');
    const stars = new Set();
    for (const [sx, sy, sp] of P.STARS) {
      const tw = 0.5 + 0.5 * Math.sin(s * 2.0 + sp * 3.0);
      if (tw > 0.25) stars.add(sx + ',' + sy);
    }
    for (let y = 0; y < P.CONFIG.H; y++) {
      for (let x = 0; x < P.CONFIG.W; x++) {
        if (stars.has(x + ',' + y)) continue;
        const ddx = (x - P.CONFIG.CX) / s0r, ddy = (y - P.CONFIG.CY) / s0r;
        const radN = Math.sqrt(ddx * ddx + Math.pow(2 * ddy, 2));
        if (radN <= 0.9 || radN > 2.0) continue;
        let fragHit = false;
        for (const f of frags) {
          const frad = f.base + pymod(s * f.speed + f.phase, 1.1);
          const fang = f.ang + s * f.spin;
          const fx = P.CONFIG.CX + frad * s0r * Math.cos(fang);
          const fy = P.CONFIG.CY + frad * s0r * 0.5 * Math.sin(fang);
          const fdx = (x - fx) / f.size, fdy = (y - fy) / (f.size * 0.5);
          if (fdx * fdx + fdy * fdy <= 1.0) { fragHit = true; break; }
        }
        if (!fragHit) continue;
        const [ch, col] = g[y][x];
        const nearCell = P.smokeCellAt(x, y, s0r, radN, smoke, s, s0Planet.seed, false);
        if (nearCell) {
          nearTotal++;
          if (ch === nearCell[0] && col === nearCell[1]) nearWins++;
        }
        const farCell = P.smokeCellAt(x, y, s0r, radN, smoke, s, s0Planet.seed, true);
        if (farCell) {
          farTotal++;
          if (!(ch === farCell[0] && col === farCell[1])) farWins++;
        }
      }
    }
  }
  check('depth: near smoke passes in front of the ring (overwrites fragments)',
    nearTotal >= 5 && nearWins === nearTotal, `${nearWins}/${nearTotal} overlaps`);
  check('depth: far smoke passes behind the ring (fragments occlude it)',
    farTotal >= 5 && farWins === farTotal, `${farWins}/${farTotal} overlaps`);
})();

// --- 13. Core rotation + dark-side pulse (Nov 11): the pulse alone
// didn't read as rotation, so a couple of characters rotate on the
// core's surface like the other stages; and the dark side didn't pulse
// at all, so the whole core must breathe. ---------------------------
// Two seeded ember patches, antipodal, one spin rate (a rigid sphere).
const lavaPlanet = P.generatePlanet(423438201); // Devon's current seed
function coreMarkersOf(planet) {
  const cm = P.buildCoreMarkers(planet.seed);
  const r = 18.0 * (planet.size || 1.0);
  return { cm, r };
}
for (const planet of [s0Planet, lavaPlanet]) {
  const { cm, r } = coreMarkersOf(planet);
  check(`core markers: 2 antipodal marks, one spin 0.5-0.9 rad/s (seed ${planet.seed})`,
    cm.marks.length === 2
      && Math.abs((cm.marks[1].lon0 - cm.marks[0].lon0) - Math.PI) < 1e-9
      && cm.spin >= 0.5 && cm.spin <= 0.9,
    `spin ${cm.spin.toFixed(2)}, lon0 ${cm.marks[0].lon0.toFixed(2)}`);
  // At every sampled second at least one marker is on the near side,
  // bright enough to read (vis >= 0.2) — the spin always has a visible
  // character, never a dead stretch.
  let worstVis = 1;
  for (const s of [0.0, 1.0, 2.0, 4.0]) {
    const best = Math.max(0,
      ...cm.marks.map(mk => {
        const p = P.coreMarkerAt(mk, cm.spin, s, r);
        return p ? p.vis : 0;
      }));
    worstVis = Math.min(worstVis, best);
  }
  check(`core markers: one visible (vis >= 0.2) at sec 0/1/2/4 (seed ${planet.seed})`,
    worstVis >= 0.2, `worst best-vis ${worstVis.toFixed(2)}`);
  // The visible marker travels: its cell moves >= 2 cells in 2s.
  const m0a = P.coreMarkerAt(cm.marks[0], cm.spin, 0.0, r);
  const m0b = P.coreMarkerAt(cm.marks[0], cm.spin, 2.0, r);
  const moved = (m0a && m0b)
    ? Math.hypot(Math.round(m0b.x) - Math.round(m0a.x), Math.round(m0b.y) - Math.round(m0a.y))
    : 0;
  check(`core marker travels >= 2 cells in 2s (seed ${planet.seed})`,
    moved >= 2, `${moved.toFixed(1)} cells`);
  // Markers stay ON the core disc (radN <= 0.6), never off to the side
  // like the old bright spot.
  let worstRadN = 0;
  for (const s of [0.0, 1.0, 2.0, 4.0]) {
    for (const mk of cm.marks) {
      const p = P.coreMarkerAt(mk, cm.spin, s, r);
      if (!p) continue;
      const radN = Math.sqrt(Math.pow((p.x - P.CONFIG.CX) / r, 2)
        + Math.pow(2 * (p.y - P.CONFIG.CY) / r, 2));
      worstRadN = Math.max(worstRadN, radN);
    }
  }
  check(`core markers stay on the disc (radN <= 0.6) (seed ${planet.seed})`,
    worstRadN <= 0.6, `worst radN ${worstRadN.toFixed(2)}`);
}
// Dark side pulses too: mean luminance of the dark side of the core
// (bottom-right quadrant — light is top-left) swings peak to trough.
function darkSideLum(planet, sec) {
  const g = P.render(planet, 0, 4.0, sec, 1.0, 'exploded');
  const r = 18.0 * (planet.size || 1.0);
  let sum = 0, n = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    for (let x = 0; x < P.CONFIG.W; x++) {
      const [ch, col] = g[y][x];
      if (col === null) continue;
      const ddx = (x - P.CONFIG.CX) / r, ddy = (y - P.CONFIG.CY) / r;
      if (Math.sqrt(ddx * ddx + Math.pow(2 * ddy, 2)) > 0.55) continue;
      if (x <= P.CONFIG.CX || y <= P.CONFIG.CY) continue;
      const [rr, gg, bb] = P.ansi256ToRgb(col);
      sum += 0.299 * rr + 0.587 * gg + 0.114 * bb; n++;
    }
  }
  return n ? sum / n : 0;
}
for (const planet of [s0Planet, lavaPlanet]) {
  // Sweep one full 3.5s cycle: max-min is the true swing, whatever the
  // phase. Gentle and even (Nov 11, Devon): the old ±0.15 pulse swung
  // the dark side ~77 lum — a violent flash. Target ~15-25, must stay
  // under 35, and clearly above zero (the dark side must breathe).
  let dMax = -Infinity, dMin = Infinity;
  for (let s = 0; s <= 3.5; s += 0.25) {
    const d = darkSideLum(planet, s);
    dMax = Math.max(dMax, d); dMin = Math.min(dMin, d);
  }
  const dSwing = dMax - dMin;
  check(`dark side pulses gently (mean lum swing over one 3.5s cycle, 12-35) (seed ${planet.seed})`,
    dSwing >= 12 && dSwing <= 35, `swing ${dSwing.toFixed(1)} (peak ${dMax.toFixed(1)} vs trough ${dMin.toFixed(1)})`);
}
// The marker's cell is brighter when the marker is on it: same pulse
// phase (sec 0 vs 3.5 — one full 3.5s cycle), so the pulse can't explain
// the difference.
for (const planet of [s0Planet, lavaPlanet]) {
  const { cm, r } = coreMarkersOf(planet);
  const g0 = P.render(planet, 0, 4.0, 0.0, 1.0, 'exploded');
  const g1 = P.render(planet, 0, 4.0, 3.5, 1.0, 'exploded');
  const lumAt = (g, c) => {
    const cell = g[c.y] && g[c.y][c.x];
    if (!cell || cell[1] === null) return -1;
    const [rr, gg, bb] = P.ansi256ToRgb(cell[1]);
    return 0.299 * rr + 0.587 * gg + 0.114 * bb;
  };
  let bestRise = -Infinity;
  for (let i = 0; i < 2; i++) {
    // A marker is usually visible at only ONE of the two times (over a
    // full 3.5s cycle it travels ~2.7 rad — nearly half a turn — so it
    // goes behind the core). Compare each visible position against the
    // SAME cell at the other time: same pulse phase, marker on vs off.
    const a = P.coreMarkerAt(cm.marks[i], cm.spin, 0.0, r);
    const b = P.coreMarkerAt(cm.marks[i], cm.spin, 3.5, r);
    if (a) {
      const ca = { x: Math.round(a.x), y: Math.round(a.y) };
      bestRise = Math.max(bestRise, lumAt(g0, ca) - lumAt(g1, ca));
    }
    if (b) {
      const cb2 = { x: Math.round(b.x), y: Math.round(b.y) };
      bestRise = Math.max(bestRise, lumAt(g1, cb2) - lumAt(g0, cb2));
    }
  }
  check(`marker cell is brighter when the marker is on it (seed ${planet.seed})`,
    bestRise >= 10, `best rise ${bestRise.toFixed(1)}`);
}
// Still no bright spot: no 231 cells on the lava seed either.
check('no bright spot on the lava seed: no 231 cells',
  !has231(lavaPlanet, 0.0) && !has231(lavaPlanet, 2.0) && !has231(lavaPlanet, 4.0),
  '231 present at some timestamp');

// 14. MUTATIONS (piece 3) -----------------------------------------------
// BIRTH MODEL (Nov 11 redesign): a planet is BORN with its mutations
// — one independent seeded roll per mutation at generation, all at the
// SAME chance (CONFIG.MUTATION_CHANCE, ~0.7% each, ~10% any). No
// tiers, no unlock stages, no cap: a mutation is visible from stage 0
// so the player can decide right away whether to keep the planet or
// destroy it for minerals. The renderer gates on the active set (the
// planet's own mutation list), never on baked fields — the plain twin
// (same planet, mutations stripped) must render plain.
// Helpers: strict channel-dominance (a grey cell is r≈g≈b, so a plain
// ratio test like g>r*1.5 lets grey ring cells pass as "cyan" — the
// differences below are real channel gaps, not ratios).
const rgbOf14 = (c) => c === null ? null : P.ansi256ToRgb(c);
const lumOf14 = (c) => { const r = rgbOf14(c); return r === null ? -1 : 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2]; };
const greenDom14 = (c) => { const r = rgbOf14(c); return !!r && r[1] - r[0] > 40 && r[1] - r[2] > 40; };
const redDom14 = (c) => { const r = rgbOf14(c); return !!r && r[0] - r[1] > 40 && r[0] - r[2] > 40; };
const cyanDom14 = (c) => { const r = rgbOf14(c); return !!r && r[1] - r[0] > 40 && r[2] - r[0] > 40; };
const magDom14 = (c) => { const r = rgbOf14(c); return !!r && r[0] - r[1] > 40 && r[2] - r[1] > 40; };
const blueDom14 = (c) => { const r = rgbOf14(c); return !!r && r[2] - r[0] > 40 && r[2] - r[1] > 40; };
function countCells14(g, pred) {
  let n = 0;
  for (let y = 0; y < P.CONFIG.H; y++) for (let x = 0; x < P.CONFIG.W; x++) if (pred(g[y][x], x, y)) n++;
  return n;
}
// First seed whose ONLY mutation is the target — a clean carrier that
// shows exactly one effect.
function singleSeed14(id) {
  for (let s = 0; s < 4000; s++) {
    const pl = P.generatePlanet(s);
    if (pl.mutations.length === 1 && pl.mutations[0] === id) {
      // Double Rings needs a base ring that ISN'T double, or the
      // mutation is a no-op for that seed (the planet rolled double
      // rings on its own — it has double rings either way).
      if (id === 'double-rings' && pl.baseRingType === 'double') continue;
      return pl;
    }
  }
  return null;
}
// The same planet with its mutations stripped — the "what would this
// look like without the mutation" twin. Note the twin keeps the baked
// ringHue / crossTilt / moon tint fields, so a render check that only
// compares the twin proves the RENDERER gates on the active mutation
// list, not on the baked fields.
function plainTwin14(pl) { const t = JSON.parse(JSON.stringify(pl)); t.mutations = []; return t; }
// Ring-frame radius: rotate the offset back by the ring tilt, then
// measure in the ring's own ellipse (rx = 2.4r, ry = 0.4r). An
// unrotated rho puts tilted ring ends far outside the band.
function rhoRot14(pl, x, y) {
  const r = P.STAGES[6].radius * pl.size;
  const t = (pl.ringTilt || 0) * Math.PI / 180;
  const dx = x - P.CONFIG.CX, dy = y - P.CONFIG.CY;
  const u = dx * Math.cos(t) + dy * Math.sin(t);
  const v = -dx * Math.sin(t) + dy * Math.cos(t);
  return Math.hypot(u / (r * 2.4), v / (r * 0.4));
}
function outsideDisc14(pl, stageIdx, x, y, pad) {
  const r = P.STAGES[stageIdx].radius * pl.size;
  const sx = (x - P.CONFIG.CX) / r, sy = (y - P.CONFIG.CY) / r;
  return sx * sx + sy * sy > pad;
}
function onDisc14(pl, stageIdx, x, y) {
  return !outsideDisc14(pl, stageIdx, x, y, 1.0);
}

// 14a. Determinism: same seed -> same mutations; same render -> same grid.
{
  let det = true;
  for (let s = 0; s < 200; s++) {
    if (JSON.stringify(P.generatePlanet(s).mutations) !== JSON.stringify(P.generatePlanet(s).mutations)) { det = false; break; }
  }
  check('mutations are deterministic (200 seeds)', det);
  const pl = singleSeed14('glitch');
  check('mutated render is deterministic',
    gridsEqual(P.render(pl, 6, 5.0, 0.8), P.render(pl, 6, 5.0, 0.8)),
    `seed ${pl.seed}`);
}

// 14b. Distribution over 5000 seeds (measured over 10,000 seeds after
// the Nov 11 City Lights cut: any 9.0%, two 0.46%, each mutation
// 0.63-0.85% — thresholds are wide on purpose; the point is the shape,
// not an exact roll).
{
  const N = 5000;
  let any = 0, maxMuts = 0;
  const per = {};
  let sizeSum = 0, huge = 0, tiny = 0;
  for (let s = 0; s < N; s++) {
    const pl = P.generatePlanet(s);
    if (pl.mutations.length > 0) any++;
    if (pl.mutations.length > maxMuts) maxMuts = pl.mutations.length;
    for (const id of pl.mutations) per[id] = (per[id] || 0) + 1;
    sizeSum += pl.size;
    if (pl.size >= 1.12) huge++;
    if (pl.size <= 0.88) tiny++;
  }
  check('most planets have NO mutation — about 1 in 10 has one (7-13%)',
    any / N > 0.07 && any / N < 0.13, `${(100 * any / N).toFixed(1)}%`);
  check('no mutation is common or vanishing — each ~0.7% (0.3-1.5%)',
    P.CONFIG.MUTATIONS.every((m) => { const r = (per[m.id] || 0) / N; return r > 0.003 && r < 0.015; }),
    P.CONFIG.MUTATIONS.map((m) => `${m.id} ${((per[m.id] || 0) / N * 100).toFixed(2)}%`).join(', '));
  check('at most 3 mutations per planet (binomial: 3+ is ~1 in 6000)',
    maxMuts <= 3, `max ${maxMuts}`);
  check('one shared chance drives every roll',
    typeof P.CONFIG.MUTATION_CHANCE === 'number' && P.CONFIG.MUTATION_CHANCE > 0 && P.CONFIG.MUTATION_CHANCE < 0.05,
    `MUTATION_CHANCE ${P.CONFIG.MUTATION_CHANCE}`);
  check('no tiers anywhere in the mutation config',
    P.CONFIG.MUTATIONS.every((m) => !('tier' in m) && !('chance' in m) && !('unlock' in m)),
    `${P.CONFIG.MUTATIONS.length} mutations, no tier/chance/unlock fields`);
  // 14c. Base rarity: extreme sizes are rarer (cubic shaping), and the
  // mean stays 1.0.
  check('mean planet size stays ~1.0', sizeSum / N > 0.97 && sizeSum / N < 1.03, `mean ${(sizeSum / N).toFixed(3)}`);
  check('huge planets (>=1.12) are rare (<6%)', huge / N < 0.06, `${(100 * huge / N).toFixed(2)}%`);
  check('tiny planets (<=0.88) are rare (<6%)', tiny / N < 0.06, `${(100 * tiny / N).toFixed(2)}%`);
}

// 14c (cont). Existing seeds keep their identity — the shaping and the
// mutation rolls must not reshuffle what a seed already was. These are
// Devon's real planets: his live Gen 2 and his archived Gen 1.
{
  const live = P.generatePlanet(423438201);
  check('Devon live planet keeps lava / wide ring / 2 moons',
    live.terrain === 'lava' && live.ringType === 'wide' && live.moons.length === 2,
    `${live.terrain} / ${live.ringType} / ${live.moons.length} moons`);
  const old = P.generatePlanet(161675658);
  check('Devon archived jungle keeps jungle / shattered / 2 moons',
    old.terrain === 'jungle' && old.ringType === 'shattered' && old.moons.length === 2,
    `${old.terrain} / ${old.ringType} / ${old.moons.length} moons`);
  // The starter pick guarantees the terrain (Devon, Nov 11): seed
  // 719571762 (Devon's archived Gen 1) draws 0.9533 on the first roll,
  // which under the old 75% lottery landed in the 25% surprise branch
  // and rolled rocky/toxic in planet.js — the Space shows it as icy
  // because that record carries forcedTerrain 'icy' (look lab). With
  // the guarantee the pick always wins, whatever the roll draws.
  let icyCount = 0;
  for (let s = 0; s < 2000; s++) if (P.generatePlanet(s, 'icy').terrain === 'icy') icyCount++;
  check('starter pick guarantees the terrain (2000/2000 icy)',
    icyCount === 2000, `${(100 * icyCount / 2000).toFixed(1)}% icy`);
}

// 14d. Labels: "MUTATION · Name" — the name with a MUTATION tag, no
// tier (there are no tiers anymore). Null when there is nothing to show.
{
  check('Glitch labels "MUTATION · Glitch"', P.mutationLabel(singleSeed14('glitch')) === 'MUTATION · Glitch',
    P.mutationLabel(singleSeed14('glitch')));
  check('Big Moon labels "MUTATION · Big Moon"', P.mutationLabel(singleSeed14('big-moon')) === 'MUTATION · Big Moon',
    P.mutationLabel(singleSeed14('big-moon')));
  check('no mutation -> no label', P.mutationLabel(plainTwin14(singleSeed14('glitch'))) === null);
  check('several mutations join with " + "',
    P.mutationLabel({ mutations: ['glitch', 'big-moon'] }) === 'MUTATION · Glitch + Big Moon');
  check('no tier helpers survive', P.tierRank === undefined && P.tierForMutations === undefined);
}

// 14e. Birth visibility: a mutation exists from stage 0 — there is no
// unlock stage anymore, so the active set is the planet's whole list
// at every stage. (The old gating checks are gone: a mutation you
// haven't grown into yet doesn't exist in this model — you see it at
// birth or not at all.)
{
  const com = singleSeed14('comet');
  check('comet active at stage 0 (born with it)', P.activeMutations(com).has('comet'));
  check('comet active at stage 6', P.activeMutations(com).has('comet'));
  check('green moon active at stage 0', P.hasMutation(singleSeed14('green-moon'), 'green-moon'));
  check('plain twin has no active mutations', P.activeMutations(plainTwin14(com)).size === 0);
}

// 14f. Render effects, one carrier per mutation, each against its plain
// twin. Thresholds are set from measured values with margin (see
// scratch/mutation-test-measure.js) — a check that fails on a real
// regression, not on noise.
// Green / Blood moon: diff-based counts (red/green stars are identical
// in both renders, so only the moon's new color counts). Measured best
// over 15 timestamps (0–14s — the moon orbits in and out of view, so a
// sparse sample can catch it hidden): green 27, blood 8.
for (const [id, fn, min] of [['green-moon', greenDom14, 4], ['blood-moon', redDom14, 5]]) {
  const pl = singleSeed14(id), tw = plainTwin14(pl);
  const outside = (x, y) => outsideDisc14(pl, 6, x, y, 1.1) && (() => { const q = rhoRot14(pl, x, y); return q < 0.5 || q > 1.05; })();
  let best = 0;
  for (let sec = 0; sec <= 14; sec += 1) {
    const gm = P.render(pl, 6, 5.0, sec), gp = P.render(tw, 6, 5.0, sec);
    let n = 0;
    for (let y = 0; y < P.CONFIG.H; y++) for (let x = 0; x < P.CONFIG.W; x++)
      if (outside(x, y) && fn(gm[y][x][1]) && !fn(gp[y][x][1])) n++;
    best = Math.max(best, n);
  }
  check(`${id}: colored moon visible (diff-based, best of 5 secs)`, best >= min, `seed ${pl.seed}, ${best} cells`);
}
// Big Moon: the generator grows the largest moon to radius 5.0, and the
// render shows a bigger moon blob than a normal moon (measured 40 cells
// vs ~28 for a radius-4 moon).
{
  const pl = singleSeed14('big-moon');
  check('big-moon grows a moon to radius 5.0',
    pl.moons.some((m) => m.radius === 5.0), `radii [${pl.moons.map((m) => m.radius)}]`);
  const r = P.STAGES[6].radius * pl.size;
  let best = 0;
  for (const sec of [0, 2.5, 5, 7.5, 10]) {
    const g = P.render(pl, 6, 5.0, sec);
    const nm = JSON.parse(JSON.stringify(pl)); nm.moons = [];
    const gn = P.render(nm, 6, 5.0, sec);
    let diff = 0;
    for (let y = 0; y < P.CONFIG.H; y++) for (let x = 0; x < P.CONFIG.W; x++) {
      const sx = (x - P.CONFIG.CX) / r, sy = (y - P.CONFIG.CY) / r;
      if (sx * sx + sy * sy < 1.02) continue;
      if (g[y][x][0] !== gn[y][x][0] || g[y][x][1] !== gn[y][x][1]) diff++;
    }
    best = Math.max(best, diff);
  }
  check('big-moon renders a bigger moon blob', best >= 35, `best ${best} cells`);
}
// Double Rings: two bands with a real gap between them (measured on the
// front ring row, tilt 0: inner 6, gap 2, outer 10).
{
  const pl = singleSeed14('double-rings');
  pl.ringTilt = 0; pl.moons = [];
  const r = P.STAGES[6].radius * pl.size;
  const g = P.render(pl, 6, 5.0, 2.5);
  const filled = (x0, x1) => {
    let n = 0;
    // Clamp to the grid: a big planet's outer band can reach the frame
    // edge (seed 433's outer band ends at x=136, exactly one past it).
    const xEnd = Math.min(Math.round(P.CONFIG.CX + x1 * r), P.CONFIG.W - 1);
    for (let x = Math.round(P.CONFIG.CX + x0 * r); x <= xEnd; x++)
      if (g[P.CONFIG.CY + 2][x][1] !== null) n++;
    return n;
  };
  check('double-rings: inner band filled', filled(1.35, 1.55) >= 3, `${filled(1.35, 1.55)} cells`);
  check('double-rings: gap between bands is empty', filled(1.7, 1.95) <= 3, `${filled(1.7, 1.95)} cells`);
  check('double-rings: outer band filled', filled(2.05, 2.35) >= 4, `${filled(2.05, 2.35)} cells`);
}
// Colored Rings: the ring takes the seeded vivid hue, not gold
// (measured 393 hue-dominant annulus cells for magenta hue 201 vs 1 in
// the plain twin — the check follows the planet's own seeded hue, not
// cyan, so it holds for whichever hue the carrier rolled).
{
  const pl = singleSeed14('colored-rings');
  const inAnn = (x, y) => outsideDisc14(pl, 6, x, y, 1.1) && (() => { const q = rhoRot14(pl, x, y); return q > 0.5 && q < 1.0; })();
  const hueDom = { 46: greenDom14, 51: cyanDom14, 93: blueDom14, 129: magDom14, 196: redDom14, 201: magDom14 }[pl.ringHue];
  const g = P.render(pl, 6, 5.0, 2.5);
  const gp = P.render(plainTwin14(pl), 6, 5.0, 2.5);
  check('colored-rings: ring is vivid, not gold',
    countCells14(g, ([, c], x, y) => inAnn(x, y) && hueDom(c)) >= 100,
    `ringHue ${pl.ringHue}`);
  check('colored-rings: plain twin ring has almost none of that hue',
    countCells14(gp, ([, c], x, y) => inAnn(x, y) && hueDom(c)) <= 5,
    `ringHue ${pl.ringHue}`);
}
// Crossed Rings: the second ring reaches where the main ring never
// does — the diagonal extremes (measured 183 cells vs 12 plain).
{
  const pl = singleSeed14('crossed-rings');
  const region = ([, c], x, y) => {
    if (c === null || onDisc14(pl, 6, x, y)) return false;
    const r = P.STAGES[6].radius * pl.size;
    const ax = Math.abs(x - P.CONFIG.CX) / r, ay = Math.abs(y - P.CONFIG.CY) / r;
    return ax >= 1.2 && ax <= 2.1 && ay >= 0.9 && ay <= 1.5;
  };
  check('crossed-rings: second ring crosses at a different angle',
    countCells14(P.render(pl, 6, 5.0, 2.5), region) >= 50,
    `crossTilt ${pl.crossTilt.toFixed(1)}°`);
  check('crossed-rings: plain twin has almost nothing there',
    countCells14(P.render(plainTwin14(pl), 6, 5.0, 2.5), region) <= 20);
}
// Crystal Crust vs Glitch — the pair that must look different. Crystal:
// pretty pastel sparkles (measured 41 strict-magenta '*' '+' cells, 0
// plain), zero harsh glyphs. Glitch: harsh scrambled glyphs (measured
// 17) and whole rows shifted sideways (measured 26 rows) — the crystal
// diff is small (5.0%) and the glitch diff is small too (4.3%), so the
// difference is the CHARACTER of the corruption, not its size.
{
  const pc = singleSeed14('crystal-crust'), pg = singleSeed14('glitch');
  const harsh = (ch) => '!<>[]'.includes(ch);
  const gc = P.render(pc, 6, 5.0, 2.5), tc = P.render(plainTwin14(pc), 6, 5.0, 2.5);
  const gg = P.render(pg, 6, 5.0, 0.8), tg = P.render(plainTwin14(pg), 6, 5.0, 0.8);
  const magSpark = ([ch, c], x, y) => onDisc14(pc, 6, x, y) && (ch === '*' || ch === '+') && magDom14(c);
  check('crystal-crust: pretty pastel sparkles on the surface',
    countCells14(gc, magSpark) >= 20, `${countCells14(gc, magSpark)} cells`);
  check('crystal-crust: plain twin has no pastel sparkles',
    countCells14(tc, magSpark) === 0);
  check('crystal-crust: zero harsh glyphs (not glitchy)',
    countCells14(gc, ([ch]) => harsh(ch)) === 0);
  check('glitch: harsh scrambled glyphs present',
    countCells14(gg, ([ch]) => harsh(ch)) >= 5, `${countCells14(gg, ([ch]) => harsh(ch))} cells`);
  const rowChars = (grid, y) => grid[y].map(([ch]) => ch).join('');
  let shifted = 0;
  for (let y = 0; y < P.CONFIG.H; y++) {
    const a = rowChars(gg, y), b = rowChars(tg, y);
    for (let k = 2; k <= 6; k++) {
      if (a.slice(k) === b.slice(0, -k) || a.slice(0, -k) === b.slice(k)) { shifted++; break; }
    }
  }
  check('glitch: whole rows shifted sideways', shifted >= 5, `${shifted} rows`);
  check('glitch: plain twin has no harsh glyphs',
    countCells14(tg, ([ch]) => harsh(ch)) === 0);
}
// Glowing Oceans: cyan waves glowing on the night side (measured 174
// cells vs 6 plain).
{
  const pl = singleSeed14('glowing-oceans'), tw = plainTwin14(pl);
  const count = (grid) => {
    let n = 0;
    const r = P.STAGES[4].radius * pl.size;
    for (let y = 0; y < P.CONFIG.H; y++) for (let x = P.CONFIG.CX + 1; x < P.CONFIG.W; x++) {
      const sx = (x - P.CONFIG.CX) / r, sy = (y - P.CONFIG.CY) / r;
      if (sx * sx + sy * sy < 1 && grid[y][x][0] === '~' && cyanDom14(grid[y][x][1])) n++;
    }
    return n;
  };
  check('glowing-oceans: night ocean glows cyan', count(P.render(pl, 4, 5.0, 2.5)) >= 50, `${count(P.render(pl, 4, 5.0, 2.5))} cells`);
  check('glowing-oceans: plain twin night ocean stays dark', count(P.render(tw, 4, 5.0, 2.5)) <= 20);
}
// Giant Storm: a big bright oval with a dark calm eye (measured at
// sec 0, when the storm sits center-disc: 114 brighter cells, 37 eye
// cells vs the plain twin).
{
  const pl = singleSeed14('giant-storm'), tw = plainTwin14(pl);
  const gm = P.render(pl, 5, 5.0, 0.0), gp = P.render(tw, 5, 5.0, 0.0);
  let brighter = 0, dimmer = 0;
  for (let y = 0; y < P.CONFIG.H; y++) for (let x = 0; x < P.CONFIG.W; x++) {
    const d = lumOf14(gm[y][x][1]) - lumOf14(gp[y][x][1]);
    if (d > 25) brighter++;
    if (d < -25) dimmer++;
  }
  check('giant-storm: big bright storm oval', brighter >= 50, `${brighter} cells`);
  check('giant-storm: dark calm eye inside it', dimmer >= 10, `${dimmer} cells`);
}
// Comet: a bright head that crosses the frame every ~14s, then is gone
// (measured '@' in color 255: 1 at sec 2.0, 0 at sec 8.0).
{
  const pl = singleSeed14('comet');
  const countHead = (sec) => countCells14(P.render(pl, 6, 5.0, sec), ([ch, c]) => ch === '@' && c === 255);
  check('comet: bright head visible mid-pass', countHead(2.0) >= 1, `${countHead(2.0)} heads`);
  check('comet: gone between passes', countHead(8.0) === 0);
}
// Meteor Shower: several bright heads at once during the burst, none
// between bursts (measured 5 at sec 1.0, 0 at sec 6.0).
{
  const pl = singleSeed14('meteor-shower');
  const countHead = (sec) => countCells14(P.render(pl, 6, 5.0, sec), ([ch, c]) => ch === '@' && c === 255);
  check('meteor-shower: several heads during the burst', countHead(1.0) >= 3, `${countHead(1.0)} heads`);
  check('meteor-shower: quiet between bursts', countHead(6.0) === 0);
}
// Sparkling Surface: white-hot glints on the lit side only (measured
// 18 vs 0 plain).
{
  const pl = singleSeed14('sparkling-surface'), tw = plainTwin14(pl);
  const glint = ([ch, c], x, y) => {
    if (!onDisc14(pl, 6, x, y) || x >= P.CONFIG.CX || (ch !== '*' && ch !== '+')) return false;
    const r = rgbOf14(c);
    if (!r) return false;
    // White-hot glints are NEUTRAL white (hue 231 shaded) — the base
    // civ sparkles are warm white (hue 230: r=255,g=255,b=215), so the
    // white branch requires b close to r, or a warm base sparkle on a
    // dim lit-side cell counts as a glint (seed 195's twin had 1).
    if (r[0] > 180 && r[1] > 180 && r[2] > 180 && r[2] > r[0] - 30) return true;
    return (r[1] > 150 && r[2] > 150 && r[0] < 100);
  };
  check('sparkling-surface: white glints on the lit side', countCells14(P.render(pl, 6, 5.0, 2.5), glint) >= 8);
  check('sparkling-surface: plain twin has none', countCells14(P.render(tw, 6, 5.0, 2.5), glint) === 0);
}
// City Lights is NOT a mutation (Devon, Nov 11): city lights are the
// Civilization STAGE feature. No planet can roll it, and the stage-6
// lights exist on a PLAIN planet. This pins that: the mutation list
// has no city-lights entry, and a plain Civilization planet still
// shows its warm night lights.
{
  check('city-lights is not in the mutation list',
    !P.CONFIG.MUTATIONS.some((m) => m.id === 'city-lights'));
  check('13 mutations total', P.CONFIG.MUTATIONS.length === 13);
  const plain = plainTwin14(singleSeed14('glitch'));
  const bright = ([ch, c], x, y) => onDisc14(plain, 6, x, y) && x > P.CONFIG.CX && ['*', '+', '.'].includes(ch) && lumOf14(c) > 100;
  let lights = 0;
  for (const sec of [0, 0.5, 1.0, 1.5]) lights += countCells14(P.render(plain, 6, 5.0, sec), bright);
  check('plain Civilization planet still has stage city lights', lights >= 10, `lights ${lights}`);
}

// 14g. Cross-stage matrix (Nov 11 redesign): every mutation must
// exist and read on ALL 7 stages — adapted per stage, not identical.
// VISIBLE_FROM is the first stage the effect can show: moons, comet,
// meteor and glitch from stage 0; sparkles and crystals from stage 1
// (the core's own sparkles carry stage 0); rings, oceans and the storm
// from stage 4, when those traits exist at all (rings open, oceans
// form, bands form). Before VISIBLE_FROM the carrier must render
// EXACTLY like its plain twin (diff 0) — the trait doesn't exist yet,
// so the mutation has nothing to act on; at and after, the diff must
// be real (>= 3 cells). Measured with scratch/cross-stage-probe.js
// (t=5.0, sec=2.5): the smallest real diffs are blood-moon 6 and
// meteor-shower 7, so 3 has margin.
{
  const VISIBLE_FROM = {
    'big-moon': 0, 'green-moon': 0, 'blood-moon': 0, 'meteor-shower': 0,
    'comet': 0, 'glitch': 0,
    'sparkling-surface': 1, 'crystal-crust': 1,
    'double-rings': 4, 'colored-rings': 4, 'crossed-rings': 4,
    'glowing-oceans': 4, 'giant-storm': 4,
  };
  const gridDiff = (a, b) => {
    let n = 0;
    for (let y = 0; y < P.CONFIG.H; y++) for (let x = 0; x < P.CONFIG.W; x++)
      if (a[y][x][0] !== b[y][x][0] || a[y][x][1] !== b[y][x][1]) n++;
    return n;
  };
  for (const mut of P.CONFIG.MUTATIONS) {
    const pl = singleSeed14(mut.id);
    if (!pl) { check(`${mut.id}: carrier seed found`, false, 'no single-mutation seed in 4000'); continue; }
    const tw = plainTwin14(pl);
    const from = VISIBLE_FROM[mut.id];
    let beforeOk = true, beforeWorst = -1, afterOk = true, afterWorst = 999;
    for (let st = 0; st < 7; st++) {
      const d = gridDiff(P.render(pl, st, 5.0, 2.5), P.render(tw, st, 5.0, 2.5));
      if (st < from) { if (d !== 0) { beforeOk = false; beforeWorst = Math.max(beforeWorst, d); } }
      else { if (d < 3) { afterOk = false; afterWorst = Math.min(afterWorst, d); } }
    }
    check(`${mut.id}: invisible before stage ${from} (trait doesn't exist yet)`, beforeOk,
      beforeWorst >= 0 ? `diff ${beforeWorst}` : `seed ${pl.seed}`);
    check(`${mut.id}: reads on every stage from ${from}`, afterOk,
      afterWorst < 999 ? `min diff ${afterWorst}` : `seed ${pl.seed}`);
  }
}

// --- 15. Planet names (step 4): deterministic, seed-tied, catalog style ----
// Format: [Catalog]-[Number][letter] — Kepler-442b, TRAPPIST-1e,
// HD-209458b, WASP-12b, TOI-700d, GJ-1214b, K2-18b. Same seed -> same
// name; catalog, number, and letter all come from the seed.
check('name: same seed -> same name',
  P.generatePlanetName(123) === P.generatePlanetName(123), P.generatePlanetName(123));
check('name: generatePlanet carries the seed name',
  P.generatePlanet(123).name === P.generatePlanetName(123));
{
  const nameRe = /^(.+)-(\d+)([b-f])$/;
  const seen = new Set();
  let bad = 0;
  for (let s = 0; s < 500; s++) {
    const n = P.generatePlanetName(s);
    seen.add(n);
    const m = nameRe.exec(n);
    const cat = m && P.CONFIG.NAME_CATALOGS.find((c) => c.prefix === m[1]);
    const num = m ? parseInt(m[2], 10) : -1;
    if (!m || !cat || num < cat.min || num > cat.max) bad++;
  }
  check('name: 500 seeds are all catalog names (prefix-number-letter b-f, number in range)', bad === 0, bad + ' bad');
  check('name: 500 seeds are almost all distinct base names (raw collisions are resolved by the birth-time layer)', seen.size >= 480, seen.size + ' distinct');
  check('name: different seeds usually differ', P.generatePlanetName(1) !== P.generatePlanetName(2));
  // Naming must not disturb the trait draws: the same seed still
  // produces the same traits it did before names existed (the name
  // runs on its own RNG stream).
  const a = P.generatePlanet(4821), b = P.generatePlanet(4821);
  check('name: same seed -> identical planet incl. name', JSON.stringify(a) === JSON.stringify(b));
  // The name is a function of the seed ONLY — starter bias and tilt
  // (which change the traits) must not change the name.
  check('name: starter bias does not change the name',
    P.generatePlanet(123, 'icy').name === P.generatePlanet(123).name);
  check('name: a tilt does not change the name',
    P.generatePlanet(123, null, { boosts: { 'green-moon': 10 } }).name === P.generatePlanet(123).name);
  // parseCatalogName round-trips the generator, and rejects junk.
  const parsed = P.parseCatalogName(P.generatePlanetName(123));
  check('name: parseCatalogName round-trips a generated name',
    !!parsed && P.formatCatalogName(parsed.catalog, parsed.num, P.CONFIG.NAME_LETTERS[parsed.letterIdx]) === P.generatePlanetName(123));
  check('name: parseCatalogName rejects a non-catalog name',
    P.parseCatalogName('Kelmor') === null && P.parseCatalogName('Kepler-999999b') === null);
}

// --- 16. Collision / fusion animation (prestige, Nov 11) --------------------
// A violent, realistic ASCII collision — not a gentle fade. Two planets
// spiral in (orbital inspiral — wide loops that tighten into the blow),
// smash (squash + white-hot flash + shockwave) and SHATTER into
// spiraling shards (Devon, Nov 11: the planets stopped dead at the
// impact — they have to break apart in pieces, spiraling as they fly
// apart, not freeze and then spray), spray debris and dust, the debris
// orbits, then the mess coalesces into the offspring. Pure function of
// (planets, t): deterministic, and the timeline has the phases the
// panel captions.
{
  const colA = P.generatePlanet(1234);
  const colB = P.generatePlanet(5678);
  const colO = P.generatePlanet(9999);
  const nonBlank = (g) => {
    let n = 0;
    for (const row of g) for (const c of row) if (c[1] !== null) n++;
    return n;
  };
  const inRegion = (g, x0, x1) => {
    let n = 0;
    for (const row of g) for (let x = x0; x <= x1; x++) if (row[x][1] !== null) n++;
    return n;
  };
  const bboxWidth = (g) => {
    let lo = 1e9, hi = -1e9;
    for (const row of g) for (let x = 0; x < row.length; x++) {
      if (row[x][1] !== null) { if (x < lo) lo = x; if (x > hi) hi = x; }
    }
    return hi - lo;
  };
  const nearCenter = (g, R) => {
    let n = 0;
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) {
      if (g[y][x][1] === null) continue;
      const dx = x - 68, dy = (y - 38) * 2;
      if (Math.sqrt(dx * dx + dy * dy) <= R) n++;
    }
    return n;
  };

  check('collision: timeline phases',
    P.collisionPhase(0) === 'approach' && P.collisionPhase(1.2) === 'impact'
    && P.collisionPhase(2.0) === 'explosion' && P.collisionPhase(3.5) === 'swirl'
    && P.collisionPhase(4.7) === 'coalesce' && P.collisionPhase(5.2) === 'done'
    && P.collisionPhase(9) === 'done');
  check('collision: END is 5.2s', P.COLLISION_END === 5.2);
  check('collision: timeline constants match the phases',
    P.COLLISION_TIMELINE.approach === 1.0 && P.COLLISION_TIMELINE.impact === 1.5
    && P.COLLISION_TIMELINE.explosion === 3.0 && P.COLLISION_TIMELINE.swirl === 4.2
    && P.COLLISION_TIMELINE.coalesce === 5.2);
  const f0 = P.collisionFrame(colA, colB, colO, 0.1);
  check('collision: frame is 136x76', f0.length === 76 && f0.every((r) => r.length === 136));
  check('collision: deterministic (same inputs + t = same frame)',
    gridsEqual(P.collisionFrame(colA, colB, colO, 2.0), P.collisionFrame(colA, colB, colO, 2.0)));
  check('collision: approach has a disc on the left and one on the right, center clear',
    inRegion(f0, 0, 45) > 100 && inRegion(f0, 90, 135) > 100 && inRegion(f0, 58, 78) < 40,
    `left ${inRegion(f0, 0, 45)} right ${inRegion(f0, 90, 135)} center ${inRegion(f0, 58, 78)}`);
  // The approach is an orbital inspiral, not a straight slide: the discs
  // swing around their common center as the orbit decays. Early in the
  // approach the left-side cluster sits above the center line; a moment
  // later it has swung below it (the old slide kept it pinned at one
  // height the whole way in). And the orbit itself shrinks: the
  // cluster separation (measured in orbit space, where rows count
  // double, as on screen) is much smaller late in the approach.
  const centroid = (g, x0, x1) => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < g.length; y++) for (let x = x0; x <= x1; x++) {
      if (g[y][x][1] !== null) { sx += x; sy += y; n++; }
    }
    return n ? { x: sx / n, y: sy / n, n } : null;
  };
  const orbitSep = (g) => {
    const L = centroid(g, 0, 67), R = centroid(g, 68, 135);
    if (!L || !R) return 0;
    return Math.hypot(L.x - R.x, 2 * (L.y - R.y));
  };
  const fA04 = P.collisionFrame(colA, colB, colO, 0.4);
  const fA09 = P.collisionFrame(colA, colB, colO, 0.9);
  check('collision: approach swings the discs around the center (inspiral, not a slide)',
    centroid(f0, 0, 67).y < 34 && centroid(fA04, 0, 67).y > 45,
    `left y at 0.1s ${centroid(f0, 0, 67).y.toFixed(1)}, at 0.4s ${centroid(fA04, 0, 67).y.toFixed(1)}`);
  check('collision: approach closes in — the orbit shrinks as it spirals',
    orbitSep(fA09) < orbitSep(f0) * 0.6,
    `orbit sep 0.1s ${orbitSep(f0).toFixed(1)} vs 0.9s ${orbitSep(fA09).toFixed(1)}`);
  const fFlash = P.collisionFrame(colA, colB, colO, 1.25);
  let flashCells = 0;
  for (let y = 0; y < fFlash.length; y++) for (let x = 0; x < fFlash[y].length; x++) {
    const c = fFlash[y][x][1];
    if ((c === 231 || c === 229) && Math.hypot(x - 68, (y - 38) * 2) < 15) flashCells++;
  }
  check('collision: impact flash is white-hot at the contact point', flashCells > 20, flashCells + ' hot cells');
  // The impact shatters the discs into shards that keep spiraling
  // (Devon, Nov 11: the planets stopped dead at the impact — they
  // have to break apart in pieces, spiraling as they fly apart, not
  // freeze and then spray). The shard motion law is a pure function:
  // radius grows and angle advances in the same direction as the
  // approach inspiral, and a shard has already travelled by 0.5s in.
  const sh0 = P.collisionShardAt(30, -1.0, 0.6, 10, 0);
  const sh05 = P.collisionShardAt(30, -1.0, 0.6, 10, 0.5);
  const sh1 = P.collisionShardAt(30, -1.0, 0.6, 10, 1.0);
  check('collision: shards spiral outward (radius grows)',
    sh05.rho > sh0.rho && sh1.rho > sh05.rho, `rho ${sh0.rho} -> ${sh05.rho} -> ${sh1.rho}`);
  check('collision: shards keep the inspiral direction (angle advances)',
    sh05.th > sh0.th && sh1.th > sh05.th,
    `th ${sh0.th.toFixed(2)} -> ${sh05.th.toFixed(2)} -> ${sh1.th.toFixed(2)}`);
  check('collision: shards move from the first instant (no frozen hold)',
    Math.hypot(sh05.x - sh0.x, 2 * (sh05.y - sh0.y)) > 1,
    `travel in 0.5s ${Math.hypot(sh05.x - sh0.x, 2 * (sh05.y - sh0.y)).toFixed(1)}`);
  // Frame-level: the disc mass itself shears at the impact — the top
  // half (planet A, moving +x at contact) shifts right and the bottom
  // half (planet B, moving -x) shifts left between 1.05s and 1.45s.
  // Disc-colored cells only (the test planets' terrain colors, derived
  // from the t=1.0 frame minus the star/dust/particle/flash palette),
  // so the flash, dust and spray can't fake the signal.
  const NON_DISC = new Set([250, 244, 242, 240, 231, 229, 226, 214, 208, 202, 196, 216, 180, 137]);
  const fDisc0 = P.collisionFrame(colA, colB, colO, 1.0);
  const discColors = new Set();
  for (let y = 10; y <= 56; y++) for (let x = 26; x <= 110; x++) {
    const c = fDisc0[y][x][1];
    if (c !== null && !NON_DISC.has(c)) discColors.add(c);
  }
  const discHalfCentroid = (g, y0, y1) => {
    let sx = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < g[y].length; x++) {
      if (discColors.has(g[y][x][1])) { sx += x; n++; }
    }
    return n ? sx / n : null;
  };
  const fI05 = P.collisionFrame(colA, colB, colO, 1.05);
  const fI145 = P.collisionFrame(colA, colB, colO, 1.45);
  check('collision: the discs shear apart at impact (top mass moves right, bottom mass left)',
    discHalfCentroid(fI145, 0, 38) - discHalfCentroid(fI05, 0, 38) > 1.5
    && discHalfCentroid(fI05, 38, 76) - discHalfCentroid(fI145, 38, 76) > 1.5,
    `top ${discHalfCentroid(fI05, 0, 38).toFixed(2)} -> ${discHalfCentroid(fI145, 0, 38).toFixed(2)}, ` +
    `bottom ${discHalfCentroid(fI05, 38, 76).toFixed(2)} -> ${discHalfCentroid(fI145, 38, 76).toFixed(2)}`);
  const fBoom = P.collisionFrame(colA, colB, colO, 2.2);
  check('collision: explosion sprays material across the frame',
    bboxWidth(fBoom) > 95 && nonBlank(fBoom) > 300,
    `bbox ${bboxWidth(fBoom)} cells ${nonBlank(fBoom)}`);
  const fSwirl = P.collisionFrame(colA, colB, colO, 3.6);
  check('collision: swirl still has debris far from the center',
    inRegion(fSwirl, 0, 37) + inRegion(fSwirl, 99, 135) > 50,
    `far cells ${inRegion(fSwirl, 0, 37) + inRegion(fSwirl, 99, 135)}`);
  const fCoal = P.collisionFrame(colA, colB, colO, 4.8);
  check('collision: coalescence pulls the mess back to the center',
    nearCenter(fCoal, 30) / Math.max(1, nonBlank(fCoal)) > 0.5,
    `${nearCenter(fCoal, 30)}/${nonBlank(fCoal)} near center`);
  const fEnd = P.collisionFrame(colA, colB, colO, 6.0);
  check('collision: finale is the offspring, whole, at the center',
    nearCenter(fEnd, 20) > 100, nearCenter(fEnd, 20) + ' cells near center');
  check('collision: the mess has settled by the finale (fewer cells than the explosion)',
    nonBlank(fEnd) < nonBlank(fBoom), `${nonBlank(fEnd)} vs ${nonBlank(fBoom)}`);
  let threw = null;
  try {
    for (const t of [0, 0.5, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 4.2, 4.5, 5, 5.2, 6, 10, -1]) {
      P.collisionFrame(colA, colB, colO, t);
    }
  } catch (e) { threw = e; }
  check('collision: no crash across the whole timeline (incl. t < 0 and t >> end)', threw === null, threw && threw.message);
  // Mutated parents collide fine too (their traits ride along).
  let mutA = null;
  for (let s = 0; s < 4000 && !mutA; s++) {
    const pl = P.generatePlanet(s);
    if (pl.mutations.length === 1 && pl.mutations[0] === 'green-moon') mutA = pl;
  }
  check('collision: a mutated parent renders and stays deterministic',
    mutA && gridsEqual(P.collisionFrame(mutA, colB, colO, 2.0), P.collisionFrame(mutA, colB, colO, 2.0)),
    mutA ? 'seed ' + mutA.seed : 'no green-moon carrier found');
}

// --- 17. Seed hatch: stripMutations (Nov 12) --------------------------------
// A planet hatched from a shared seed is the SAME base planet — same
// seed = same planet — but WITHOUT mutations. Mutations stay unique
// to the original: nobody gets your rare mutated planet just by
// pasting its seed.
{
  // A mutated carrier, stripped: same identity, no mutations, base
  // traits restored, summary recomputed, original untouched.
  const carrier = singleSeed14('double-rings'); // grants a ring the base roll didn't give
  const orig = JSON.parse(JSON.stringify(carrier));
  const stripped = P.stripMutations(carrier);
  check('strip: mutations cleared', stripped.mutations.length === 0);
  check('strip: no mutation label', P.mutationLabel(stripped) === null);
  check('strip: no active mutations', P.activeMutations(stripped).size === 0);
  check('strip: seed/terrain/size/name unchanged',
    stripped.seed === orig.seed && stripped.terrain === orig.terrain && stripped.size === orig.size && stripped.name === orig.name,
    `${stripped.seed} ${stripped.terrain} ${stripped.size} ${stripped.name}`);
  check('strip: ring back to the base ring', stripped.ringType === orig.baseRingType, `${orig.ringType} -> ${stripped.ringType} (base ${orig.baseRingType})`);
  check('strip: ringHue / crossTilt cleared', stripped.ringHue === null && stripped.crossTilt === null);
  check('strip: summary recomputed from base traits',
    stripped.summary === `${stripped.terrainLabel} world · ${stripped.ringLabel.toLowerCase()} · ${stripped.moons.length} moon${stripped.moons.length === 1 ? '' : 's'}`,
    stripped.summary);
  check('strip: original untouched', JSON.stringify(carrier) === JSON.stringify(orig));
  // A stripped planet renders EXACTLY like its plain twin
  // (mutations=[] only) — stripping is bookkeeping, not a different
  // planet — and DIFFERENTLY from the mutated original.
  let sameAsTwin = true, diffFromOrig = false;
  for (const sec of [0, 2.5, 5.0]) {
    if (!gridsEqual(P.render(stripped, 6, 5.0, sec), P.render(plainTwin14(orig), 6, 5.0, sec))) sameAsTwin = false;
    if (!gridsEqual(P.render(stripped, 6, 5.0, sec), P.render(orig, 6, 5.0, sec))) diffFromOrig = true;
  }
  check('strip: renders exactly like the plain twin', sameAsTwin);
  check('strip: renders differently from the mutated original', diffFromOrig);
}
{
  // Moons: a Big Moon shrinks back to its base radius and tint, and
  // the moon count stays — the moon itself isn't the mutation.
  const carrier = singleSeed14('big-moon');
  const stripped = P.stripMutations(carrier);
  check('strip: big moon shrinks back to its base radius',
    stripped.moons.every((m) => m.radius === m.baseRadius), `radii [${stripped.moons.map((m) => m.radius)}]`);
  check('strip: moon tints back to base', stripped.moons.every((m) => m.tint === m.baseTint));
  check('strip: moon count unchanged', stripped.moons.length === carrier.moons.length);
  // Ring mutations: the granted color and the second tilt go away.
  const s1 = P.stripMutations(singleSeed14('colored-rings'));
  check('strip: colored-rings carrier loses its hue', s1.ringHue === null && s1.ringType === s1.baseRingType);
  const s2 = P.stripMutations(singleSeed14('crossed-rings'));
  check('strip: crossed-rings carrier loses its second tilt', s2.crossTilt === null && s2.ringType === s2.baseRingType);
}
{
  // A plain planet is untouched by stripping (deep equal).
  let plain = null;
  for (let s = 0; s < 4000 && !plain; s++) { const pl = P.generatePlanet(s); if (pl.mutations.length === 0) plain = pl; }
  check('strip: plain planet is unchanged (deep equal)',
    JSON.stringify(P.stripMutations(plain)) === JSON.stringify(plain));
  // Every mutation strips cleanly (13/13).
  let allOk = true, worst = '';
  for (const m of P.CONFIG.MUTATIONS) {
    const carrier = singleSeed14(m.id);
    if (!carrier) { allOk = false; worst = m.id + ' no carrier'; break; }
    const s = P.stripMutations(carrier);
    const ok = s.mutations.length === 0 && s.ringType === carrier.baseRingType && s.ringHue === null && s.crossTilt === null
      && s.moons.every((mo) => mo.radius === mo.baseRadius && mo.tint === mo.baseTint && mo.mutantIds.length === 0)
      && s.seed === carrier.seed && s.terrain === carrier.terrain && s.name === carrier.name;
    if (!ok) { allOk = false; worst = m.id; break; }
  }
  check('strip: every mutation strips cleanly (13/13)', allOk, worst);
  // Determinism: same seed -> same stripped planet.
  check('strip: deterministic (same seed -> same stripped planet)',
    JSON.stringify(P.stripMutations(P.generatePlanet(12345))) === JSON.stringify(P.stripMutations(P.generatePlanet(12345))));
}

// --- 18. Solar-system disc rules (Devon, Nov 12) ---------------------------
// (1) Stage-driven scale: a planet's rendered size grows with its stage —
// stage 0 is 0.7x the size of stage 6 (was 0.5; Devon found stage 0 a
// speck in the Index, Nov 12 F5 feedback). (2) No per-planet stars in the
// solar system: render()/renderCozy() take a noStars flag; the orrery
// discs and Index tiles pass it, standalone frames don't. (3) Full
// rings in the orrery: ringFitZoom shrinks a planet just enough that
// its whole ring system fits the disc grid — verified empirically by
// rendering with rings vs rings stripped and checking no ring cell
// touches the output border.
{
  // (1) stageScale: 0.5 at stage 0, 1.0 at stage 6, strictly increasing.
  const scales = [0, 1, 2, 3, 4, 5, 6].map((s) => P.stageScale(s));
  check('disc: stageScale is 0.7 at stage 0 and 1.0 at stage 6',
    scales[0] === 0.7 && scales[6] === 1.0, scales.join(', '));
  check('disc: stageScale strictly increases with stage',
    scales.every((v, i) => i === 0 || v > scales[i - 1]));
  // A stage-0 planet really does render smaller than a mature one:
  // bounding-box width at the disc zoom, on a moonless planet (so no
  // moon inflates the box).
  function discBBWidth(planet, stage, sec) {
    const zoom = Math.min(P.stageScale(stage), P.ringFitZoom(planet, stage, 46, 24));
    const g = P.downsampleGrid(P.render(planet, stage, 10, sec, zoom, undefined, 0.5, true), 46, 24);
    let lo = 46, hi = -1;
    for (let y = 0; y < 24; y++) for (let x = 0; x < 46; x++) {
      if (g[y][x][0] !== ' ') { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    }
    return hi - lo + 1;
  }
  let moonless = null;
  for (let s = 1; s < 20000 && !moonless; s++) {
    const p = P.generatePlanet(s);
    if (p.moons.length === 0) moonless = p;
  }
  const w0 = discBBWidth(moonless, 0, 5), w5 = discBBWidth(moonless, 5, 5), w6 = discBBWidth(moonless, 6, 5);
  check('disc: stage-0 planet renders clearly smaller than a Life-stage one',
    w0 < 0.6 * w6 && w0 < w5, `stage0=${w0} life=${w5} civ=${w6} cells wide`);
  // (2) noStars: a tiny render's far corners hold stars normally and
  // nothing at all with noStars.
  function cornerCount(grid) {
    const H = grid.length, W = grid[0].length, CX = 68, CY = 38;
    let c = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((Math.abs(x - CX) > 55 || Math.abs(y - CY) > 30) && grid[y][x][0] !== ' ') c++;
    }
    return c;
  }
  const starProbe = P.generatePlanet(12345);
  check('disc: noStars drops the starfield (corners go blank)',
    cornerCount(P.render(starProbe, 6, 10, 5, 0.3)) > 0
    && cornerCount(P.render(starProbe, 6, 10, 5, 0.3, undefined, 1, true)) === 0);
  check('disc: renderCozy passes noStars through (output border blank)',
    (() => {
      const g = P.renderCozy(starProbe, 6, 10, 5, 0.3, 46, 24, undefined, 1, true);
      for (let x = 0; x < 46; x++) if (g[0][x][0] !== ' ' || g[23][x][0] !== ' ') return false;
      for (let y = 0; y < 24; y++) if (g[y][0][0] !== ' ' || g[y][45][0] !== ' ') return false;
      return true;
    })());
  check('disc: stars are still on by default (noStars omitted)',
    cornerCount(P.render(starProbe, 6, 10, 5, 0.3)) > 0);
  // (3) ringFitZoom: 1.0 for ringless planets, <= 1 always, and the
  // empirical fit — no ring cell touches the disc border.
  let ringless = null;
  for (let s = 1; s < 5000 && !ringless; s++) {
    const p = P.generatePlanet(s);
    if (p.ringType === 'none' && p.mutations.length === 0) ringless = p;
  }
  check('disc: ringFitZoom is 1.0 for a ringless planet',
    P.ringFitZoom(ringless, 6, 46, 24) === 1.0);
  let fitOk = true, fitMin = 1;
  for (let s = 1; s <= 3000; s++) {
    const f = P.ringFitZoom(P.generatePlanet(s), 6, 46, 24);
    if (f > 1.0 || f < 0.35) { fitOk = false; break; }
    fitMin = Math.min(fitMin, f);
  }
  check('disc: ringFitZoom stays in [0.35, 1.0] over 3000 seeds', fitOk, 'min ' + fitMin.toFixed(3));
  function stripRings(pl) {
    const c = JSON.parse(JSON.stringify(pl));
    c.ringType = 'none';
    c.baseRingType = 'none';
    c.mutations = (c.mutations || []).filter((m) => m !== 'double-rings' && m !== 'colored-rings' && m !== 'crossed-rings');
    return c;
  }
  let checked = 0, clipped = 0, worstMargin = 99;
  for (let seed = 1; seed <= 40000 && checked < 42; seed++) {
    const pl = P.generatePlanet(seed);
    if (pl.ringType === 'none' && !pl.mutations.some((m) => ['double-rings', 'colored-rings', 'crossed-rings'].includes(m))) continue;
    for (const stage of [4, 5, 6]) {
      const zoom = Math.min(P.stageScale(stage), P.ringFitZoom(pl, stage, 46, 24));
      const a = P.downsampleGrid(P.render(pl, stage, 10, 5, zoom, undefined, 0.5, true), 46, 24);
      const b = P.downsampleGrid(P.render(stripRings(pl), stage, 10, 5, zoom, undefined, 0.5, true), 46, 24);
      let minEdge = 99;
      for (let y = 0; y < 24; y++) for (let x = 0; x < 46; x++) {
        if (a[y][x][0] !== b[y][x][0] || a[y][x][1] !== b[y][x][1]) {
          minEdge = Math.min(minEdge, x, 45 - x, y, 23 - y);
        }
      }
      checked++;
      if (minEdge < 1) clipped++;
      worstMargin = Math.min(worstMargin, minEdge);
    }
  }
  check('disc: full rings fit — no ring cell touches the disc border',
    clipped === 0, `${checked} renders, ${clipped} clipped, worst margin ${worstMargin} cell(s)`);
}

// --- 20. Starfield layer (Devon, Nov 12) -------------------------------------
// The stars are a layer of the FRAME, not part of the planet: a frame
// fills its own box with P.starfieldHtml (the same 80 stars, scaled
// from the 136x76 reference) and puts the star-free planet render on
// top. At 136x76 the layer is exactly the old baked-in starfield.
{
  const atmo = 27;
  // At the reference size the layer IS the old starfield, cell for cell.
  check('stars: starfieldGrid(136, 76) is identical to starGrid',
    JSON.stringify(P.starfieldGrid(136, 76, 5, atmo)) === JSON.stringify(P.starGrid(5, atmo)));
  // It scales to any frame: every star lands inside the new bounds,
  // glyphs stay . + *, colors stay 244 / atmosphere.
  function starCells(g) {
    let n = 0;
    for (const row of g) for (const [ch, col] of row) {
      if (ch !== ' ') {
        n++;
        if (!['.', '+', '*'].includes(ch) || (col !== 244 && col !== atmo)) return -1;
      }
    }
    return n;
  }
  const distinct = new Set(P.STARS.map(([sx, sy]) => sx + ',' + sy)).size;
  const small = P.starfieldGrid(34, 19, 5, atmo);
  const big = P.starfieldGrid(258, 137, 5, atmo);
  // Twinkle hides some stars at any given sec — compare against the
  // VISIBLE count at the reference size, not the 80 positions.
  const visibleRef = starCells(P.starfieldGrid(136, 76, 5, atmo));
  check('stars: scaled layer keeps valid glyphs and colors',
    starCells(small) > 0 && starCells(big) > 0, `small=${starCells(small)} big=${starCells(big)} ref=${visibleRef}`);
  check('stars: scaling down only loses stars to collisions, never adds',
    starCells(small) <= visibleRef && starCells(big) <= distinct);
  check('stars: a bigger frame keeps every visible star (no collisions scaling up)',
    starCells(big) === visibleRef, `${starCells(big)} vs ${visibleRef} visible at 136x76`);
  // Positions scale with the frame: the first star lands at its
  // scaled coordinates (checked at a sec where it is visibly on).
  const [sx0, sy0, sp0] = P.STARS[0];
  let visSec = null;
  for (let s = 0; s < 40 && visSec === null; s += 0.5) {
    if (0.5 + 0.5 * Math.sin(s * 2.0 + sp0 * 3.0) > 0.7) visSec = s;
  }
  const scaled = P.starfieldGrid(200, 100, visSec, atmo);
  const ex = Math.round(sx0 * 199 / 135), ey = Math.round(sy0 * 99 / 75);
  check('stars: positions scale proportionally with the frame',
    scaled[ey][ex][0] !== ' ', `star 0 -> ${ex},${ey} at sec ${visSec}`);
  // Twinkle: same sec -> same sky, different sec -> a different sky.
  check('stars: layer twinkles with sec and is deterministic per sec',
    JSON.stringify(P.starfieldGrid(68, 38, 5, atmo)) === JSON.stringify(P.starfieldGrid(68, 38, 5, atmo))
    && JSON.stringify(P.starfieldGrid(68, 38, 5, atmo)) !== JSON.stringify(P.starfieldGrid(68, 38, 5.4, atmo)));
  // Composition: a star-free planet render + the layer, overlaid, is
  // the old stars-baked-in render. A cell is empty iff its COLOR is
  // null — the night side is RAMP[0] (a space) with a dark color, so
  // a blank char alone does not mean empty. (Planets without sky
  // mutations only — comet / meteor-shower / glitch paint the sky
  // themselves, so the layer would double-count there.)
  const skyMut = new Set(['comet', 'meteor-shower', 'glitch']);
  let composed = 0, composeOk = true, stage0Diffs = 0, stage0BareDrawn = true;
  for (let s = 1; s <= 200 && composed < 3; s++) {
    const pl = P.generatePlanet(s);
    if ((pl.mutations || []).some((m) => skyMut.has(m))) continue;
    for (const stage of [0, 6]) {
      const withStars = P.render(pl, stage, 10, 5, 1.0);
      const bare = P.render(pl, stage, 10, 5, 1.0, undefined, 1, true);
      const layer = P.starfieldGrid(136, 76, 5, pl.atmosphere);
      for (let y = 0; y < 76; y++) for (let x = 0; x < 136; x++) {
        const over = bare[y][x][1] === null ? layer[y][x] : bare[y][x];
        if (over[0] !== withStars[y][x][0] || over[1] !== withStars[y][x][1]) {
          if (stage === 6) { composeOk = false; break; }
          // Stage 0 only: the renderer yields to a star — a sparkle
          // or fragment it drew over the star's cell in the bare
          // render, where the starred render kept the star. One or
          // two cells per planet, and the planet's own debris in
          // front of a background star is the correct depth order.
          stage0Diffs++;
          if (bare[y][x][1] === null) stage0BareDrawn = false;
        }
      }
      if (!composeOk) break;
    }
    composed++;
  }
  check('stars: noStars render + layer overlays to exactly the starred render (stage 6)',
    composeOk, `${composed} planets`);
  check('stars: stage-0 overlay differs only where the renderer drew over a star',
    stage0Diffs <= 15 && stage0BareDrawn, `${stage0Diffs} differing cells across ${composed} planets`);
  // The night side must be opaque in HTML: dark space-only runs get
  // their color as a background, so the starfield layer behind never
  // shows through the dark disc. Bright space cells (a city light
  // swallowed by a dark belt) stay transparent.
  // Round 3 (Nov 12 — black squares at stage 1+): the night side is
  // speckled, not solid — pattern noise pushes the brightness across
  // the space threshold cell by cell — so a short dark run painted
  // with a background is a small sharp rectangle ("black square") at
  // full-res sizes. Round 4: the 4+ rule left the solid night side
  // painting (77 spans over 41 frames, max run 8) — those ARE the
  // rectangles Devon sees. Only runs of 10+ cells (a truly solid
  // stretch) get a background now; 1-9 cell speckle stays transparent
  // (on black it reads as black anyway, no rectangle). The 10-cell
  // run below still paints; the 9-cell run in the speckle grid does not.
  const nightGrid = [[[' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], ['.', 232]], [[' ', 229], [' ', null], ['*', 250]]];
  const nightHtml = P.gridToHtml(nightGrid, 10, 18);
  check('stars: dark space runs paint their background (opaque night side)',
    nightHtml.includes('background:#000000'));
  const speckleGrid = [[['.', 232], [' ', 16], [' ', 16], ['.', 232]], [[' ', 16], ['.', 232], [' ', 16], [' ', 16]], [[' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], [' ', 16], ['.', 232]]];
  const speckleHtml = P.gridToHtml(speckleGrid, 10, 18);
  check('stars: short dark runs (1-9 cells, terminator speckle) stay transparent — no black squares',
    !speckleHtml.includes('background:'));
  check('stars: bright space runs stay transparent (no background)',
    !nightHtml.includes('background:#ffffaf') && !nightHtml.includes('background:#ffffd7'));
  check('stars: glyph runs are untouched by the background rule',
    !nightHtml.includes('background:#080808'));
  check('stars: starfieldHtml is gridToHtml of the layer',
    P.starfieldHtml(46, 24, 5, atmo, 2.6, 4.68) === P.gridToHtml(P.starfieldGrid(46, 24, 5, atmo), 2.6, 4.68));
}

// --- 19. Continuous zoom detail (Devon, Nov 12 — F5 feedback) -------------
// The orrery planet was a pixelated blob while the detail sheet looked
// good: the disc only had THREE stepped tiers (46x24 / 92x48 / 136x76)
// and the glyphs were CSS-scaled between them. Devon's rule: glyph
// size NEVER changes with zoom — zooming changes how many characters
// there are (more detail in, cozier out), tracking the camera zoom
// smoothly. So the grid resolution is computed from the disc's
// on-screen size divided by a fixed cell size (discDetail), and the
// disc is counter-scaled in the panel so the glyphs are rasterized at
// their final size. The sun gets the same treatment (sunDetail).
{
  // discDetail is continuous in the camera zoom, not stepped: 1.5x
  // lands between 1x and 2x, and 1.99 vs 2.01 differ by at most a cell.
  const d03 = P.discDetail(0.3), d1 = P.discDetail(1), d15 = P.discDetail(1.5),
    d199 = P.discDetail(1.99), d201 = P.discDetail(2.01), d26 = P.discDetail(2.6),
    d3 = P.discDetail(3), d100 = P.discDetail(100);
  check('zoom: detail is continuous — 1.5x lands between 1x and 2x, not on a tier',
    d1.cols === 23 && d15.cols === 34 && d199.cols === 46 && d201.cols === 46 && d26.cols === 60,
    `1->${d1.cols} 1.5->${d15.cols} 1.99->${d199.cols} 2.01->${d201.cols} 2.6->${d26.cols}`);
  check('zoom: no tier jump at 2x — 1.99 and 2.01 differ by at most 1 cell',
    Math.abs(d199.cols - d201.cols) <= 1 && Math.abs(d199.rows - d201.rows) <= 1,
    `${d199.cols}x${d199.rows} vs ${d201.cols}x${d201.rows}`);
  check('zoom: resolution caps at the full 136x76 render',
    d3.cols === 69 && d100.cols === P.CONFIG.W && d100.rows === P.CONFIG.H,
    `3->${d3.cols}x${d3.rows} 100->${d100.cols}x${d100.rows}`);
  check('zoom: zooming out goes cozier (fewer chars), never vanishes',
    d03.cols === 8 && d03.rows === 6, `${d03.cols}x${d03.rows}`);
  check('zoom: glyph size is constant at every zoom (5.2x9.36, round 2 — readable, was 2.6x6.12)',
    [d03, d1, d15, d26, d3].every((d) => d.cellW === 5.2 && d.cellH === 9.36));
  check('zoom: columns grow monotonically with zoom',
    [0.3, 0.5, 1, 1.5, 2, 2.6, 3].map((z) => P.discDetail(z).cols)
      .every((v, i, a) => i === 0 || v >= a[i - 1]));
  // The disc's local (counter-scaled) size is its on-screen size:
  // cols*cellW == world width * zoom (capped at the full grid), so
  // the planet never jumps as the resolution changes.
  check('zoom: disc local size tracks on-screen size (cols*cellW == 119.6*zoom, capped)',
    [0.5, 1, 2, 2.6, 3].every((z) => {
      const d = P.discDetail(z);
      const want = Math.min(119.6 * z, P.CONFIG.W * 5.2);
      return Math.abs(d.cols * d.cellW - want) < 5.2;
    }));
  // Same planet, just sharper: the 136x76 grid downsampled to 23x16
  // is exactly the 23x16 grid (the 1:1 downsample is the identity).
  const zp = P.generatePlanet(40059);
  const z = Math.min(P.stageScale(6), P.ringFitZoom(zp, 6, 23, 16));
  const hi = P.renderCozy(zp, 6, 10, 5, z, 136, 76, undefined, 0.5, true);
  const lo = P.renderCozy(zp, 6, 10, 5, z, 23, 16, undefined, 0.5, true);
  check('zoom: 136x76 grid downsampled to 23x16 is exactly the 23x16 grid',
    gridsEqual(P.downsampleGrid(hi, 23, 16), lo));
  // And the denser grids really do carry more detail.
  const count = (g) => g.flat().filter((c) => c[0] !== ' ').length;
  const mid = P.renderCozy(zp, 6, 10, 5, z, 69, 47, undefined, 0.5, true);
  const n0 = count(lo), n1 = count(mid), n2 = count(hi);
  check('zoom: denser grids show strictly more non-blank cells',
    n0 < n1 && n1 < n2, `23x16=${n0} 69x47=${n1} 136x76=${n2}`);
  // Ring fit stays conservative at the top resolution: the base disc
  // zoom (computed at 46x24) still fits the whole ring system at 136x76.
  let fitOk = true;
  for (let s = 1; s <= 3000; s++) {
    const pl = P.generatePlanet(s);
    if (P.ringFitZoom(pl, 6, 136, 76) < P.ringFitZoom(pl, 6, 23, 16) - 1e-9) { fitOk = false; break; }
  }
  check('zoom: ringFitZoom at 136x76 is never tighter than at 23x16', fitOk);
  function stripRings2(pl) {
    const c = JSON.parse(JSON.stringify(pl));
    c.ringType = 'none';
    c.baseRingType = 'none';
    c.mutations = (c.mutations || []).filter((m) => m !== 'double-rings' && m !== 'colored-rings' && m !== 'crossed-rings');
    return c;
  }
  let checked2 = 0, clipped2 = 0;
  for (let seed = 1; seed <= 40000 && checked2 < 12; seed++) {
    const pl = P.generatePlanet(seed);
    if (pl.ringType === 'none' && !pl.mutations.some((m) => ['double-rings', 'colored-rings', 'crossed-rings'].includes(m))) continue;
    for (const stage of [5, 6]) {
      const zoom2 = Math.min(P.stageScale(stage), P.ringFitZoom(pl, stage, 23, 16));
      const a = P.renderCozy(pl, stage, 10, 5, zoom2, 136, 76, undefined, 0.5, true);
      const b = P.renderCozy(stripRings2(pl), stage, 10, 5, zoom2, 136, 76, undefined, 0.5, true);
      let minEdge = 99;
      for (let y = 0; y < 76; y++) for (let x = 0; x < 136; x++) {
        if (a[y][x][0] !== b[y][x][0] || a[y][x][1] !== b[y][x][1]) {
          minEdge = Math.min(minEdge, x, 135 - x, y, 75 - y);
        }
      }
      checked2++;
      if (minEdge < 1) clipped2++;
    }
  }
  check('zoom: full rings still fit at the top resolution (base disc zoom)',
    clipped2 === 0, `${checked2} renders, ${clipped2} clipped`);
  // sunDetail: same rule as the discs — resolution tracks the zoom,
  // glyph size constant, capped at 2x (168x84) so the DOM stays bounded.
  const s05 = P.sunDetail(0.5), s1 = P.sunDetail(1), s2 = P.sunDetail(2), s3 = P.sunDetail(3);
  check('zoom: sun resolution tracks zoom — 56x28 at 1x, 112x56 at 2x',
    s1.cols === 56 && s1.rows === 28 && s2.cols === 112 && s2.rows === 56,
    `1->${s1.cols}x${s1.rows} 2->${s2.cols}x${s2.rows}`);
  check('zoom: sun caps at 3x (168 cols) and grows cells instead past it',
    s3.cols === 168 && s3.rows === 84 && s3.cellW === 5.5 && s3.cellH === 9.9,
    `3->${s3.cols}x${s3.rows} @ ${s3.cellW}x${s3.cellH}`);
  check('zoom: sun goes cozier zoomed out (28x14 at 0.5x)',
    s05.cols === 28 && s05.rows === 14, `${s05.cols}x${s05.rows}`);
  check('zoom: sun glyph size is constant at every zoom (5.5x9.9, round 2 — was 3.67x6.6)',
    s05.cellW === 5.5 && s05.cellH === 9.9 && s1.cellW === 5.5 && s2.cellW === 5.5 && s3.cellW === 5.5);
}

// --- 21. Sidebar crop + share PNG density (Devon, Nov 12 — F5 feedback) ----
// The sidebar pet was a small planet in a big black grid; now the
// render is cropped to the planet's own extent (sidebarCrop) and shown
// star-free on the VS Code gray. And the share PNG passed P.CONFIG.W/H
// as stage0Style/smokeScale, which drew stage 0 as a sparse
// non-exploded core (264 cells instead of 670).
{
  const cp = P.generatePlanet(805839337);
  const countCells = (g) => g.flat().filter((c) => c[1] !== null).length;
  // The crop covers the body + moons + atmosphere at every stage, and
  // is much smaller than the full grid — so the planet fills the frame.
  for (const st of [0, 1, 6]) {
    const box = P.sidebarCrop(cp, st, 10);
    const r = P.STAGES[st].radius * cp.size;
    check(`crop: stage ${st} box covers the body (r=${r})`,
      box.cols >= 2 * r * 1.5 && box.rows >= r * 1.5,
      `${box.cols}x${box.rows} for r=${r}`);
    check(`crop: stage ${st} box is much smaller than the full grid`,
      box.cols < P.CONFIG.W && box.rows < P.CONFIG.H, `${box.cols}x${box.rows}`);
  }
  // The settled content (body + smoke + moons) sits inside the crop —
  // the rings may touch the edge (they are allowed to clip), but the
  // planet itself never is.
  for (const st of [0, 6]) {
    const box = P.sidebarCrop(cp, st, 10);
    const g = P.render(cp, st, 10, 5, 1.0, undefined, 1, true);
    let loX = 999, hiX = -1, loY = 999, hiY = -1;
    for (let y = 0; y < 76; y++) for (let x = 0; x < 136; x++) {
      if (g[y][x][1] === null) continue;
      // Rings are excluded: they are allowed to clip. A ring cell is
      // far from the center in x (beyond the body's 1.7x margin) —
      // approximate by only counting cells within the crop's own
      // x-range widened by the ring band. Simpler: the body is the
      // disc — check the central band (the disc's own rows) is inside.
      if (Math.abs(y - 38) > 20) continue;
      loX = Math.min(loX, x); hiX = Math.max(hiX, x);
      loY = Math.min(loY, y); hiY = Math.max(hiY, y);
    }
    // Round 2: the stage-0 margin tightened 2.2 -> 1.6 for bigger
    // sidebar glyphs, so the sparse smoke fringe may touch the crop
    // edge (a few dim cells past it); the body + dense burst stay
    // inside. The 4-cell allowance is the fringe, not the planet.
    check(`crop: stage ${st} central content sits inside the crop (4-cell fringe allowance)`,
      loX >= box.x0 - 4 && hiX < box.x0 + box.cols + 4 && loY >= box.y0 - 4 && hiY < box.y0 + box.rows + 4,
      `content x[${loX},${hiX}] y[${loY},${hiY}] vs crop x[${box.x0},${box.x0 + box.cols - 1}] y[${box.y0},${box.y0 + box.rows - 1}]`);
  }
  // cropGrid slices correctly and the cropped render is dense — the
  // planet fills its frame instead of sitting small in a big grid.
  for (const st of [0, 6]) {
    const box = P.sidebarCrop(cp, st, 10);
    const g = P.render(cp, st, 10, 5, 1.0, undefined, 1, true);
    const cg = P.cropGrid(g, box);
    check(`crop: cropGrid returns the stage-${st} box`,
      cg[0].length === box.cols && cg.length === box.rows, `${cg[0].length}x${cg.length}`);
    check(`crop: cropped stage-${st} render is dense (planet fills it)`,
      countCells(cg) > 400, `${countCells(cg)} non-blank of ${box.cols * box.rows}`);
  }
  // The crop is stable across secs (geometry-based, not content-based)
  // and follows the birth morph (wider at t=0, tighter settled).
  const b0 = P.sidebarCrop(cp, 0, 10), b0b = P.sidebarCrop(cp, 0, 5.4);
  check('crop: same box at different secs (no flicker jitter)',
    b0.cols === b0b.cols && b0.rows === b0b.rows, `${b0.cols}x${b0.rows}`);
  const bBirth = P.sidebarCrop(cp, 0, 0);
  check('crop: birth morph starts wider than the settled core',
    bBirth.cols > b0.cols, `t=0: ${bBirth.cols} vs settled: ${b0.cols}`);
  // Share PNG input: the canonical stage-0 render is dense. The old
  // buggy call (stage0Style=136, smokeScale=76) drew only 264 cells.
  const s0 = P.render(cp, 0, 10, 5, 1.0);
  check('share: canonical stage-0 render is dense (not the 264-cell bug)',
    countCells(s0) > 600, `${countCells(s0)} non-blank cells`);
  const s0buggy = P.render(cp, 0, 10, 5, 1.0, P.CONFIG.W, P.CONFIG.H);
  check('share: the old arg order really was wrong (sparse stage 0)',
    countCells(s0buggy) < countCells(s0) / 2, `${countCells(s0buggy)} vs ${countCells(s0)}`);
}

// --- 22. Round-3 pixel blocks (Devon, Nov 12 — F5 feedback) --------------
// The composed visual, not just the pieces: a downsampled stage-0
// render must contain NO opaque dark-space cells — those are what
// gridToHtml paints as solid rectangles in the smoke fringe. The
// diagnosis (41 frames on Devon's real planet GJ-364c, seed
// 948502300) found them at every frame in every downsampled view;
// the fix lives in downsampleGrid (dense-block rule + glyph re-read).
// The night side is the one place dark spaces belong, so a mature
// planet's downsample must KEEP some.
{
  function darkSpaceCells(grid) {
    let n = 0;
    for (const row of grid) for (const [ch, col] of row) {
      if (ch === ' ' && col !== null && col !== undefined) {
        const [r, g, b] = P.ansi256ToRgb(col);
        if ((r + g + b) / 3 < 96) n++;
      }
    }
    return n;
  }
  const gj = P.generatePlanet(948502300);
  // Devon's planet is icy by starter pick; the smoke fringe is a
  // stage-0 feature on any terrain, so the base seed is enough here.
  let worst = 0, worstLabel = '';
  for (const [ow, oh, label] of [[69, 47, 'disc@3x'], [46, 24, 'disc@2x'], [23, 16, 'fit'], [34, 19, 'thumb']]) {
    let max = 0;
    for (let i = 0; i <= 40; i++) {
      const sec = +(i * 0.15).toFixed(2);
      const dz = Math.min(P.stageScale(0), P.ringFitZoom(gj, 0, ow, oh));
      max = Math.max(max, darkSpaceCells(P.renderCozy(gj, 0, 10, sec, dz, ow, oh, undefined, 0.5, true)));
    }
    if (max > worst) { worst = max; worstLabel = label; }
  }
  check('pixel-blocks: downsampled stage-0 renders have 0 dark-space cells (41 frames, 4 sizes)',
    worst === 0, `worst ${worst} at ${worstLabel}`);
  // Sidebar coarse fallback: crop, then downsample half and quarter.
  const crop = P.sidebarCrop(gj, 0, 10);
  let worstCoarse = 0;
  for (let i = 0; i <= 40; i++) {
    const sec = +(i * 0.15).toFixed(2);
    const g = P.cropGrid(P.render(gj, 0, 10, sec, 1.0, undefined, 0.5, true), crop);
    worstCoarse = Math.max(worstCoarse,
      darkSpaceCells(P.downsampleGrid(g, Math.max(1, Math.floor(g[0].length / 2)), Math.max(1, Math.floor(g.length / 2)))),
      darkSpaceCells(P.downsampleGrid(g, Math.max(1, Math.floor(g[0].length / 4)), Math.max(1, Math.floor(g.length / 4)))));
  }
  check('pixel-blocks: sidebar coarse fallback has 0 dark-space cells (41 frames)',
    worstCoarse === 0, `worst ${worstCoarse}`);
  // Night side preserved: a mature planet's downsample still has
  // opaque dark-space cells (the disc's dark half over the starfield).
  let nightKept = true, nightDetail = '';
  for (const seed of [40059, 805839337, 948502300, 12345]) {
    const pl = P.generatePlanet(seed);
    const full6 = P.render(pl, 6, 10, 5, 1.0, undefined, 0.5, true);
    const d46 = darkSpaceCells(P.downsampleGrid(full6, 46, 24));
    nightDetail += `${seed}:${d46} `;
    if (d46 === 0) nightKept = false;
  }
  check('pixel-blocks: night side keeps opaque dark-space cells in the downsample',
    nightKept, nightDetail.trim());
  // Stage 1+ (Devon, Nov 12 — black squares in the panel): the full
  // render DOES have dark-space cells from stage 1 on (the night side
  // exists once the planet has a disc — 75 at stage 1 on GJ-364c,
  // vs 0 at stage 0), so the grid-level count can't be 0 there. What
  // must hold is the HTML: the detail sheet may only paint a
  // background on the solid night side, never on the terminator
  // speckle. Round 3's run-length rule (>=4 cells) left the solid
  // night side painting — 77 spans over 41 frames, max run 8, pure
  // #000000 — and those ARE the rectangles Devon sees. Round 4
  // raised the threshold to 10: no run paints at stage 1 (max
  // observed length 8 over 41 frames), and stage 6 keeps at most one
  // solid-night-side run (measured 1).
  function sheetBgSpans(planet, stageIdx) {
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
      const sec = +(i * 0.15).toFixed(2);
      const g = P.render(planet, stageIdx, 10, sec, 1.0, undefined, 0.5, true);
      const sheet = P.cropGrid(g, P.sidebarCrop(planet, stageIdx, 10));
      const html = P.gridToHtml(sheet, 5.2, 9.36);
      worst = Math.max(worst, (html.match(/background:/g) || []).length);
    }
    return worst;
  }
  const gj1 = P.generatePlanet(948502300, 'icy');
  const s1spans = sheetBgSpans(gj1, 1), s6spans = sheetBgSpans(gj1, 6);
  check('pixel-blocks: stage-1 detail sheet paints zero bg spans (41 frames)',
    s1spans === 0, `stage1 worst ${s1spans}`);
  check('pixel-blocks: stage-6 detail sheet paints at most one solid night-side run (41 frames)',
    s6spans <= 2, `stage6 worst ${s6spans}`);
  // FIX 2's resolution half: discDetail reaches the full 136 cols at
  // ~5.91x zoom (the 6x cap), so the zoomed disc can match the sheet.
  check('zoom: discDetail reaches the full 136 cols at ~5.91x (6x cap)',
    P.discDetail(5.91).cols === 136 && P.discDetail(6).cols === 136 && P.discDetail(3).cols === 69,
    `5.91->${P.discDetail(5.91).cols} 6->${P.discDetail(6).cols} 3->${P.discDetail(3).cols}`);
  // Round-4 zoom blend (Devon, Nov 12 — one mouse scroll jumped the
  // disc from few characters to a ton): the round-3 switch at 2x
  // jumped the disc char count 43 -> 288 (6.7x) in one step. The
  // blend ramps the crop in over z=2..4, so no 0.1 zoom step may jump
  // the count by more than 2x. Replicates renderDiscs exactly via
  // P.discBlend (same box, same output size, same render).
  function blendedChars(planet, z) {
    const detail = P.discDetail(z);
    const dz = Math.min(P.stageScale(1), P.ringFitZoom(planet, 1, detail.cols, detail.rows));
    const zcrop = P.sidebarCrop(planet, 1, 10, 2.5);
    const bl = P.discBlend(z, zcrop, detail, false);
    const full = P.render(planet, 1, 10, 2, dz, undefined, 0.5, true);
    const cropped = P.cropGrid(full, bl.box);
    const grid = (bl.outCols < bl.box.cols || bl.outRows < bl.box.rows)
      ? P.downsampleGrid(cropped, bl.outCols, bl.outRows) : cropped;
    let n = 0;
    for (const row of grid) for (const [ch] of row) if (ch !== ' ') n++;
    return n;
  }
  let prevChars = 0, worstRatio = 0;
  for (let zi = 15; zi <= 25; zi++) {
    const n = blendedChars(gj1, zi / 10);
    if (prevChars) worstRatio = Math.max(worstRatio, n / prevChars);
    prevChars = n;
  }
  check('zoom-blend: no 0.1 zoom step jumps the disc char count by more than 2x (z=1.5..2.5)',
    worstRatio < 2, `worst ratio ${worstRatio.toFixed(2)}x`);
  // Blend endpoints: blend 0 is exactly the cozy render; blend 1 is
  // exactly the old cropped render (full detail at high zoom kept).
  const cozy19 = P.renderCozy(gj1, 1, 10, 2,
    Math.min(P.stageScale(1), P.ringFitZoom(gj1, 1, P.discDetail(1.9).cols, P.discDetail(1.9).rows)),
    P.discDetail(1.9).cols, P.discDetail(1.9).rows, undefined, 0.5, true);
  let nCozy = 0;
  for (const row of cozy19) for (const [ch] of row) if (ch !== ' ') nCozy++;
  check('zoom-blend: blend 0 equals the cozy render at z=1.9',
    blendedChars(gj1, 1.9) === nCozy, `blended ${blendedChars(gj1, 1.9)} vs cozy ${nCozy}`);
  const zcrop1 = P.sidebarCrop(gj1, 1, 10, 2.5);
  const d47 = P.discDetail(4.7);
  const dz47 = Math.min(P.stageScale(1), P.ringFitZoom(gj1, 1, d47.cols, d47.rows));
  let nOld = 0;
  for (const row of P.cropGrid(P.render(gj1, 1, 10, 2, dz47, undefined, 0.5, true), zcrop1))
    for (const [ch] of row) if (ch !== ' ') nOld++;
  check('zoom-blend: blend 1 equals the old cropped render at z=4.7 (full detail kept)',
    blendedChars(gj1, 4.7) === nOld, `blended ${blendedChars(gj1, 4.7)} vs cropped ${nOld}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
