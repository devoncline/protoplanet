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

// Starter bias: 200 rolls with starter 'icy' should be mostly icy.
let icyCount = 0;
for (let s = 0; s < 200; s++) {
  if (P.generatePlanet(s, 'icy').terrain === 'icy') icyCount++;
}
check('starter bias works (~75% icy)', icyCount >= 130 && icyCount <= 175, `${icyCount}/200 icy`);

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
for (let i = 0; i < 8; i++) {
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
  // The starter bias is a 75% lottery, not a guarantee: seed 719571762
  // (Devon's archived Gen 1) draws 0.9533 on the first roll, so it lands
  // in the 25% surprise branch and rolls rocky/toxic in planet.js — the
  // Space shows it as icy because that record carries forcedTerrain
  // 'icy' (look lab), not because the starter roll gave icy. What
  // planet.js must preserve is the RATE: ~75% + the 1-in-10 chance the
  // surprise branch rolls icy anyway ≈ 77%.
  let icyCount = 0;
  for (let s = 0; s < 2000; s++) if (P.generatePlanet(s, 'icy').terrain === 'icy') icyCount++;
  check('starter pick biases terrain to the pick (~70-85% icy)',
    icyCount / 2000 > 0.70 && icyCount / 2000 < 0.85, `${(100 * icyCount / 2000).toFixed(1)}% icy`);
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
// exist and read on ALL 8 stages — adapted per stage, not identical.
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
    for (let st = 0; st < 8; st++) {
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
