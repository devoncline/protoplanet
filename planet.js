// planet.js — Piece 1 of the Protoplanet VS Code extension.
// The foundation everything else builds on:
//
//   1. A SEEDED GENERATOR: a numeric seed -> a unique planet, every time.
//      Same seed = same planet, forever. No AI, just an algorithm
//      (mulberry32 PRNG + weighted trait rolls), No Man's Sky style.
//   2. A JS RENDERER: started as a faithful port of ../lifecycle.py's
//      render math (same ramp, same fixed top-left light, same spin
//      illusion, same ring math) — then RESTYLED toward the reel's look
//      (Nov 11): higher grid resolution, limb fade, softer light — then
//      restyled AGAIN (round 2, Nov 11, from Devon's screenshots of the
//      reel's frames + code): BRIGHTNESS FIRST. The glyph is picked from
//      a continuous brightness float, the terrain color stays the cell's
//      color scaled in lightness by the brightness (BODY_TINT 1.0 —
//      Devon's correction, Nov 11: keep our colors, borrow only the
//      reel's shading style, NOT its near-monochrome palette), a
//      dedicated limb glow term (body = lit*fill + limb*0.9), and the
//      reel's belt/storm weights (belts darken ≤35%, storm adds ≤55%
//      of lit).
//      The JS renderer is now the LOOK AUTHORITY: it intentionally
//      diverges from lifecycle.py, which stays as the original Python
//      loop. Same seeds still produce the same planets — only the
//      drawing changed, never the generator.
//
// Plain JS, no dependencies, no build step. Runs in Node (for tests and
// sample dumps) and in a VS Code webview (loaded via <script>).
// In Node:  const P = require('./planet.js');
// In a browser/webview: <script src="planet.js"></script> gives window.Protoplanet.

'use strict';

// ---------------------------------------------------------------------------
// CONFIG — every tunable number lives here, in one place, with comments.
// Devon can retune weights / colors / sizes here after playing.
// ---------------------------------------------------------------------------
const CONFIG = {
  // Grid size — 136x76, center 68,38. The reel runs ~135x74; this is
  // the same neighborhood, and it is INTENTIONALLY bigger than
  // lifecycle.py's 100x48. More cells across the disc = smoother
  // gradients and more room for mutations to show later. The JS renderer
  // is the look authority now — it no longer matches the Python loop
  // cell-for-cell, by design.
  W: 136, H: 76, CX: 68, CY: 38,

  // Cell size in CSS px for HTML rendering — MUST stay in the 10:18 ratio,  // the same ratio the PIL renderer uses (make-samples.py) and the approved
  // v5 clip. With this ratio the disc's cell-ellipse (x-radius r, y-radius
  // r/2) displays as a circle: 2r*10 wide vs r*18 tall = 20:18 ≈ 1.11.
  // The preview page may scale both numbers down on narrow screens, but
  // the RATIO must never change — it is what makes the planet round.
  // The grid is bigger now (136 wide), so at full scale a planet is
  // 1360px wide and the cells are small on screen — that IS the reel's
  // look (small characters, big planet).
  CELL_W: 10, CELL_H: 18,

  // Brightness-first shading (round 2, Nov 11 — the reel's rule): the
  // glyphs ARE the shading, color is the terrain color scaled in
  // lightness by the brightness (lit side brighter, night side darker).
  // BODY_TINT is how much of the terrain hue shows: 1.0 = full color
  // (Devon's choice, Nov 11 — he likes our colors, we are NOT copying
  // the reel's near-monochrome palette, only its shading style).
  // 0 would be pure grey shading (the reel's look). RING_TINT is 1.0
  // for the same reason: full gold, scaled by the ring's brightness
  // (far side dim, shadow dimmer).
  BODY_TINT: 1.0, RING_TINT: 1.0,

  // One density-ordered brightness ramp for the whole frame, dark -> bright.
  // Letters and numbers are in the mix, but nothing spells anything.
  RAMP: ' .,:;i1ltf+*x=oc2a57#08%&B$@',

  // Fixed top-left light, normalized. It never moves — the reel's rule.
  LIGHT: [-0.7, -0.55, 0.45],

  // --- Procedural generation: trait lists and weights ---------------------
  // A planet's terrain picks its three latitude band colors (dark pole,
  // mid, bright pole). Weight = how often the algorithm rolls it.
  // Higher weight = more common. Tweak these to taste.
  TERRAINS: [
    { id: 'rocky',   label: 'Rocky',   bands: [137, 130, 94],  weight: 16, desc: 'Bare rock and dust.' },
    { id: 'ocean',   label: 'Ocean',   bands: [27, 33, 39],    weight: 15, desc: 'Deep blue seas.' },
    { id: 'jungle',  label: 'Jungle',  bands: [46, 34, 22],    weight: 14, desc: 'Thick green growth.' },
    { id: 'icy',     label: 'Icy',     bands: [159, 123, 45],  weight: 13, desc: 'Frozen, pale and bright.' },
    { id: 'desert',  label: 'Desert',  bands: [214, 180, 137], weight: 11, desc: 'Endless sand.' },
    { id: 'lava',    label: 'Lava',    bands: [196, 202, 88],  weight: 9,  desc: 'Molten rock, still hot.' },
    { id: 'gas',     label: 'Gas',     bands: [99, 105, 141],  weight: 8,  desc: 'Banded clouds, no ground.' },
    { id: 'crystal', label: 'Crystal', bands: [201, 165, 129], weight: 6,  desc: 'Glittering mineral crust.' },
    { id: 'toxic',   label: 'Toxic',   bands: [118, 82, 46],   weight: 5,  desc: 'Acid skies, strange seas.' },
    { id: 'metal',   label: 'Metal',   bands: [250, 244, 238], weight: 3,  desc: 'Bare polished metal.' },
  ],

  // Atmosphere color: tints the bright twinkling stars (dim stars stay 244).
  ATMOSPHERES: [
    { code: 250, weight: 30 }, // pale white (classic)
    { code: 51,  weight: 16 }, // cyan
    { code: 226, weight: 14 }, // gold
    { code: 201, weight: 12 }, // magenta
    { code: 46,  weight: 12 }, // green
    { code: 196, weight: 8 },  // red
    { code: 99,  weight: 8 },  // violet
  ],

  // Ring types. `outer` is the ring's outer edge in planet-radius units
  // (Python default is 2.4). `colors` = [front inner, front mid, front
  // outer, back inner, back outer]. Weights: none is common on purpose —
  // rings should feel earned, like the loop where they only open late.
  RING_TYPES: [
    { id: 'none',     label: 'No rings',    weight: 30, outer: 0,   colors: null },
    { id: 'thin',     label: 'Thin ring',   weight: 24, outer: 1.8, colors: [221, 180, 178, 137, 94] },
    { id: 'wide',     label: 'Wide ring',   weight: 24, outer: 2.4, colors: [221, 180, 178, 137, 94] },
    { id: 'double',   label: 'Double ring', weight: 10, outer: 2.45, colors: [221, 180, 178, 137, 94] },
    { id: 'colored',  label: 'Ice ring',    weight: 7,  outer: 2.4, colors: [51, 45, 39, 38, 31] },
    { id: 'shattered',label: 'Shattered',   weight: 5,  outer: 2.4, colors: [221, 180, 178, 137, 94] },
  ],

  // Ring tilt: the ring plane's tilt (degrees, signed) — a seeded
  // per-planet trait (Nov 11, Devon's overnight list). Real ringed
  // planets are seen at different axial tilts, so rings should not
  // always sit perfectly horizontal. Most planets are near-flat;
  // steep tilts are rare. Rolled as a weighted bucket + a uniform
  // angle inside it + a random direction (left/right).
  RING_TILT_BUCKETS: [
    { label: 'flat',   min: 0,  max: 4,  weight: 40 },
    { label: 'slight', min: 4,  max: 10, weight: 30 },
    { label: 'tilted', min: 10, max: 20, weight: 20 },
    { label: 'steep',  min: 20, max: 32, weight: 10 },
  ],

  // --- Planet names (step 4, Nov 11; catalog style, Nov 11) --------------
  // Every planet gets a name tied to its seed — deterministic, so the
  // same seed always produces the same name. Names look like real
  // exoplanet catalog designations — [Catalog]-[Number][letter]
  // (Kepler-442b, TRAPPIST-1e, HD-209458b, WASP-12b, TOI-700d,
  // GJ-1214b, K2-18b) — picked by a SEPARATE mulberry32 stream seeded
  // from the planet's seed, so naming never consumes draws from the
  // trait generator and can never reshuffle a planet's traits.
  // Number ranges are plausible for each catalog: Kepler numbers run
  // into the thousands, HD into the hundreds of thousands, TRAPPIST
  // is a small family. The letter is b–f, like real exoplanets
  // (b = the first planet found around that star).
  NAME_CATALOGS: [
    { prefix: 'Kepler',   min: 1,    max: 1650 },
    { prefix: 'TRAPPIST', min: 1,    max: 12 },
    { prefix: 'HD',       min: 1000, max: 250000 },
    { prefix: 'WASP',     min: 1,    max: 200 },
    { prefix: 'TOI',      min: 100,  max: 7000 },
    { prefix: 'GJ',       min: 1,    max: 1300 },
    { prefix: 'K2',       min: 1,    max: 500 },
    { prefix: 'HAT-P',    min: 1,    max: 100 },
    { prefix: 'CoRoT',    min: 1,    max: 40 },
    { prefix: 'NGTS',     min: 1,    max: 80 },
    { prefix: 'XO',       min: 1,    max: 20 },
    { prefix: 'LHS',      min: 1000, max: 6000 },
  ],
  NAME_LETTERS: ['b', 'c', 'd', 'e', 'f'],

  // Moon styles: each moon is a tiny shaded sphere now (Nov 11), with
  // a seeded size and tint. Radius is in grid cells (the planet's
  // radius is ~28 cells, so moons stay small next to it).
  MOON_RADII: [
    { radius: 2.0, weight: 40 }, // small
    { radius: 3.0, weight: 40 }, // medium
    { radius: 4.0, weight: 20 }, // big
  ],
  MOON_TINTS: [
    { code: 244, weight: 35 }, // grey (classic moon)
    { code: 250, weight: 20 }, // bright white
    { code: 180, weight: 15 }, // warm tan
    { code: 153, weight: 12 }, // pale ice blue
    { code: 209, weight: 10 }, // peach
    { code: 137, weight: 8 },  // rusty brown-grey
  ],

  // Moons: how many small moons orbit the planet (0-3).
  MOON_COUNT: [
    { n: 0, weight: 45 },
    { n: 1, weight: 30 },
    { n: 2, weight: 18 },
    { n: 3, weight: 7 },
  ],

  // Planet size: radius multiplier rolled from the seed.
  // BASE RARITY (Nov 11, Devon): a naturally crazy-looking planet —
  // huge, or multiple rings — should be RARER in generation, but it is
  // NOT a mutation. The size draw is shaped, not uniform: the same rng
  // value as before is compressed toward the middle with a cubic curve
  // (see generatePlanet), so huge/tiny planets are rare while every
  // other trait a seed already had stays byte-identical. Ring rarity
  // already lives in RING_TYPES weights (double/colored/shattered are
  // the rarest rolls); a huge planet WITH multiple rings is rare on
  // both counts, so the combo is rarer still.
  SIZE_MIN: 0.85, SIZE_MAX: 1.15,

  // --- Mutations (piece 3, Nov 11) ---------------------------------------
  // Inheritable traits: special visual effects a planet can be born
  // with. MUTATIONS (piece 3, redesigned Nov 11, 2:27 PM — Devon's call).
  // NO TIERS: Devon can't categorize a cool mutation, so every
  // mutation is on ONE tier — all just really rare, roughly equal.
  // BIRTH ROLLS: a planet is born with its mutations (rolled at
  // generation, visible from stage 0), so the player can decide
  // right away whether to keep growing it or destroy it for minerals
  // to make a new one (the recycle loop — the destroy mechanic itself
  // is step 2, not this run). One independent seeded roll per
  // mutation, all at the SAME chance below — one tunable value, so
  // Devon can retune after playing. At 0.007 each, ~9% of planets
  // are born with at least one mutation (1-(1-0.007)^14), ~0.4%
  // with two. Most planets have NO mutation — when one shows up,
  // it's special. `tags` are the mineral families that tilt toward
  // this mutation (step 2: feeding tilts the NEXT planet's roll).
  MUTATION_CHANCE: 0.007,
  MUTATIONS: [
    { id: 'big-moon',          name: 'Big Moon',         tags: ['moon'],  desc: 'One oversized moon.' },
    { id: 'double-rings',      name: 'Double Rings',     tags: ['rings'], desc: 'Two parallel rings.' },
    { id: 'sparkling-surface', name: 'Sparkling Surface', tags: ['glow'],  desc: 'The surface glints in the light.' },
    { id: 'colored-rings',     name: 'Colored Rings',    tags: ['rings'], desc: 'Rings in a vivid color, not gold.' },
    { id: 'glowing-oceans',    name: 'Glowing Oceans',   tags: ['glow'],  desc: 'The oceans glow on the night side.' },
    { id: 'meteor-shower',     name: 'Meteor Shower',    tags: ['sky'],   desc: 'Streaks fall across the planet.' },
    { id: 'crystal-crust',     name: 'Crystal Crust',    tags: ['glow'],  desc: 'The surface sparkles with crystals.' },
    { id: 'giant-storm',       name: 'Giant Storm',      tags: ['storm'], desc: 'A Jupiter-style storm with an eye.' },
    { id: 'comet',             name: 'Comet',            tags: ['sky'],   desc: 'A comet passes by, again and again.' },
    { id: 'crossed-rings',     name: 'Crossed Rings',    tags: ['rings'], desc: 'Two rings at different angles, crossing.' },
    { id: 'green-moon',        name: 'Green Moon',       tags: ['moon'],  desc: 'A moon that glows neon green.' },
    { id: 'blood-moon',        name: 'Blood Moon',       tags: ['moon'],  desc: 'A blood-red moon.' },
    { id: 'glitch',            name: 'Glitch',           tags: ['weird'], desc: 'The planet looks broken — on purpose.' },
  ],
};

// ---------------------------------------------------------------------------
// PLANET NAMES — deterministic, seed-tied, real catalog style (step 4).
// ---------------------------------------------------------------------------
// A planet's name looks like a real exoplanet catalog designation —
// [Catalog]-[Number][letter] (Kepler-442b, TRAPPIST-1e, HD-209458b,
// WASP-12b, TOI-700d, GJ-1214b, K2-18b). Catalog, number, and letter
// are all picked from the seed by a SEPARATE mulberry32 stream, so
// naming never consumes draws from the trait generator and can never
// reshuffle a planet's traits. Same seed -> same name, always.
function generatePlanetName(seed) {
  const rng = mulberry32((seed ^ 0x9E3779B9) >>> 0);
  const cats = CONFIG.NAME_CATALOGS;
  const letters = CONFIG.NAME_LETTERS;
  // Weighted catalog pick: weight = log10 of the catalog's name space
  // (numbers x letters). Small famous catalogs (TRAPPIST) still show
  // up regularly instead of HD swallowing two-thirds of all planets,
  // and raw collisions stay modest — the birth-time uniqueness layer
  // in petLogic.js guarantees no two planets in a collection share a
  // name anyway.
  let total = 0;
  const weights = cats.map((c) => {
    const w = Math.log10((c.max - c.min + 1) * letters.length);
    total += w;
    return w;
  });
  let pick = rng() * total;
  let cat = cats[cats.length - 1];
  for (let i = 0; i < cats.length; i++) {
    pick -= weights[i];
    if (pick < 0) { cat = cats[i]; break; }
  }
  const num = cat.min + Math.trunc(rng() * (cat.max - cat.min + 1));
  const letter = letters[Math.trunc(rng() * letters.length)];
  return formatCatalogName(cat, num, letter);
}

// One place that builds a catalog name, so the generator and the
// uniqueness nudge can never drift apart in format.
function formatCatalogName(cat, num, letter) {
  return `${cat.prefix}-${num}${letter}`;
}

// Parse a catalog name back into { catalog, num, letterIdx } — the
// uniqueness layer in petLogic.js nudges the number/letter when a
// name is already taken. Returns null for names that aren't in
// catalog form (e.g. a stored custom name).
function parseCatalogName(name) {
  if (typeof name !== 'string') return null;
  const m = /^(.+)-(\d+)([b-f])$/.exec(name);
  if (!m) return null;
  const cat = CONFIG.NAME_CATALOGS.find((c) => c.prefix === m[1]);
  if (!cat) return null;
  const num = parseInt(m[2], 10);
  if (num < cat.min || num > cat.max) return null;
  return { catalog: cat, num, letterIdx: CONFIG.NAME_LETTERS.indexOf(m[3]) };
}

// ---------------------------------------------------------------------------
// Lifecycle stages — identities copied from lifecycle.py (names, modes,
// durations, patterns, ring openness, descriptions). The `bands` here
// are the stage defaults; a generated planet's terrain bands REPLACE them
// at render time (see renderPlanet). RADII are 1.5x the Python originals:
// the grid is bigger now (136x76 vs 100x48) and the reel's planet fills
// the frame, so the disc is bigger in cells too.
// ---------------------------------------------------------------------------
const STAGES = [
  { name: 'Shattered birth', mode: 'dust', radius: 18.0, ring: 0.0,  dur: 8, pat: [1.0, 0.0],  bands: [250, 244, 67],  desc: 'A world bursts apart — molten core, fragments flying.' },
  { name: 'Accretion',     mode: 'rock', radius: 19.5, ring: 0.0,  dur: 7,  pat: [1.2, 0.30], bands: [137, 130, 94],  desc: 'Rocks collide and stick — a lumpy little world.' },
  { name: 'Molten',        mode: 'molten', radius: 24.0, ring: 0.0, dur: 8,  pat: [1.8, 0.45], bands: [196, 202, 214], desc: 'Bombardment melts everything. A lava ocean.' },
  { name: 'Crust',         mode: 'crust', radius: 24.0, ring: 0.0,  dur: 7,  pat: [1.0, 0.25], bands: [240, 238, 130], desc: 'The surface cools and hardens, cracks still glowing.' },
  { name: 'Oceans',        mode: 'ocean', radius: 27.0, ring: 0.35, dur: 9,  pat: [0.6, 0.15], bands: [27, 33, 39],    banded: true, desc: 'Water pools, clouds drift, waves roll.' },
  { name: 'Life',          mode: 'life', radius: 28.5, ring: 0.6,  dur: 9,  pat: [1.2, 0.35], bands: [28, 34, 40],    banded: true, desc: 'Green spreads across the continents.' },
  { name: 'Civilization',  mode: 'civ', radius: 28.5, ring: 1.0,  dur: 10, pat: [1.0, 0.20], bands: [19, 27, 22],    banded: true, desc: 'City lights blink on the night side. Rings open wide.' },
  { name: 'End',           mode: 'end', radius: 21.0, ring: 0.7,  dur: 8,  pat: [1.4, 0.30], bands: [52, 88, 124],   desc: 'The star ages. Oceans boil off, embers fade.' },
];

// Stage-0 looks (Nov 11): the first thing people see when they start a
// planet. Devon picked the winner — 'exploded' ("Shattered birth") is the
// final stage-0 look (Nov 11, 9:26 AM), with the old dust sprinkle and the
// nebula kept as alternates behind the `stage0Style` flag ('dust' |
// 'nebula' | 'exploded'), default 'exploded'. STAGES[0] takes the
// winner's name/description.
const STAGE0_STYLES = {
  dust:     { name: 'Dust cloud',     desc: 'Loose dust and gas, slowly pulling together.' },
  nebula:   { name: 'Nebula',         desc: 'Gas and dust swirl together, glowing as a new world gathers.' },
  exploded: { name: 'Shattered birth', desc: 'A world bursts apart — molten core, fragments flying.' },
};

// Starfield — the exact same 80 stars as lifecycle.py (random.seed(42)),
// dumped from Python so every planet shares the same sky.
// Each star: [x, y, speed, char].
const STARS = [[28,3,1.6123257496397494,"."],[57,17,1.6047068212460185,"+"],[22,75,1.1328827295279056,"."],[23,27,0.8489913400861093,"+"],[6,71,0.7982564760299727,"+"],[107,28,1.1738135694257803,"*"],[1,20,1.5472090924823403,"*"],[71,19,0.8229706431613832,"*"],[26,11,1.069890950956006,"*"],[88,33,1.7106924099115703,"+"],[117,68,0.6872392442798141,"*"],[20,70,0.9397674221106393,"+"],[92,73,0.7884328853849898,"."],[11,29,1.659602511183038,"."],[59,12,1.0701893375587492,"*"],[93,20,1.055271450675324,"."],[68,9,1.4136965085004822,"."],[62,20,1.1933903177766736,"*"],[56,41,1.7642778802847143,"."],[58,4,1.7075687011568215,"*"],[68,8,0.8164742653794896,"+"],[80,27,1.4831579979423202,"*"],[117,18,0.8973202497470787,"."],[67,74,1.1426507409418696,"+"],[102,46,0.8289811387359249,"."],[130,63,0.6363641182606908,"."],[28,19,1.4411690625546352,"+"],[108,8,1.07715096751175,"+"],[119,67,0.8771211799727198,"+"],[2,14,1.5225655535398621,"+"],[68,43,0.6673282603938147,"*"],[40,58,0.5048679741525939,"+"],[67,64,1.642943298578097,"+"],[27,38,1.7625040222587005,"+"],[50,19,1.060870778886722,"."],[135,0,1.3984168766903435,"*"],[4,14,1.8936479243969258,"*"],[61,7,0.8613073886708497,"+"],[20,10,1.5978613922669416,"."],[32,16,1.489626234121051,"+"],[42,33,1.2915106811273809,"+"],[108,27,1.8933702395032652,"+"],[51,39,1.0984884499961436,"+"],[95,56,1.849421126964418,"*"],[30,31,0.8370460055473361,"*"],[5,75,1.3308822836367198,"+"],[56,0,0.6064896290135489,"+"],[15,29,0.6011004921654612,"."],[84,9,1.2712341797128837,"*"],[124,27,1.308850897092132,"+"],[121,31,1.67692913643613,"*"],[48,12,0.6453962213432349,"*"],[90,54,1.116653414074607,"+"],[13,12,0.5909190111155205,"+"],[86,13,0.8729845008804284,"."],[114,17,1.1328224597516063,"*"],[118,31,1.81172893110587,"."],[113,70,0.6468630923024006,"+"],[3,11,1.8895504745121914,"."],[42,52,1.2284616881760777,"."],[102,7,0.7469556821022902,"."],[99,33,1.889777110339,"*"],[73,54,1.5448872554002437,"+"],[124,19,0.7848468009014558,"."],[14,74,1.6036057681835652,"."],[80,7,0.5752135058959303,"*"],[128,67,0.7361490919092248,"+"],[20,23,0.6027819990556885,"."],[60,51,0.6798299209206863,"+"],[63,74,1.3917787303001619,"+"],[20,53,1.4860597467087837,"+"],[133,40,1.902059386604641,"."],[80,30,0.8984217687970307,"."],[76,58,0.974265794407781,"."],[2,58,1.4317388832396392,"+"],[25,9,1.306451606152441,"+"],[67,16,1.8998890669905637,"."],[62,47,0.9274810868249851,"*"],[77,67,0.5117346607282369,"+"],[76,13,1.9083950058906558,"."]];

// ---------------------------------------------------------------------------
// Small helpers — same semantics as the Python originals.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  // Deterministic PRNG: same seed -> same stream of numbers, forever.
  // (The whole procedural-generation idea depends on this.)
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Python-style modulo: always non-negative (JS % can go negative).
function pymod(v, n) { return ((v % n) + n) % n; }

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) {
  if (lo === undefined) { lo = 0.0; hi = 1.0; }
  return Math.max(lo, Math.min(hi, v));
}

// Same sin-hash noise as lifecycle.py's noise2().
function noise2(x, y, seed) {
  if (seed === undefined) seed = 0.0;
  return pymod(Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453, 1.0);
}

// Seeded smooth value noise — the organic continent field (texture-motion
// fix, Nov 11). Classic value noise: a lattice of seeded random values,
// bilinearly interpolated with a smoothstep. Unlike the stage sine
// lattice (pat), this is blobby and irregular, and it is SEEDED per
// planet — rerolling the seed gives genuinely different continents.
// Longitude (u) is PERIODIC with `period` lattice cells: the texture
// wraps around the planet, so a continent that drifts off the right
// edge re-enters on the left after one full turn. Latitude (v) does not
// wrap (the poles are the ends of the world).
function hash2(ix, iy, seed) {
  return pymod(Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453, 1.0);
}
function valueNoise(u, v, seed, period) {
  const iu = Math.floor(u), iv = Math.floor(v);
  const fu = u - iu, fv = v - iv;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv); // smoothstep
  const at = (ix, iy) => hash2(((ix % period) + period) % period, iy, seed);
  const a = at(iu, iv), b = at(iu + 1, iv), c = at(iu, iv + 1), d = at(iu + 1, iv + 1);
  return lerp(lerp(a, b, su), lerp(c, d, su), sv);
}
// Two-octave continent field in texture space. u = texture longitude in
// radius units (one full turn = 4 units); v = latitude in radius units.
// Octave 1: 8 cells around the planet (cell = 0.5 radius units, ~14
// cells on screen) — the big landmasses. Octave 2: 16 cells (cell =
// 0.25), half weight — the wobble that makes coastlines irregular.
// The cells must be SMALL relative to the visible disc (2 units wide):
// with 1-unit cells the window held only ~4 of them, so the land
// fraction swung wildly (0-50%) from seed to seed and second to second.
// With 0.5-unit cells the window holds ~16, so coverage stays near
// ~28% for every planet at every moment. Returns ~[0, 1] (mean ~0.5).
// Same (u, v, seed) -> same value, forever; different seed ->
// different continents.
function continentField(u, v, seed) {
  const o1 = valueNoise(u * 2, v * 2, seed, 8);
  const o2 = valueNoise(u * 4, v * 4, seed + 101, 16);
  return clamp(0.65 * o1 + 0.35 * o2, 0, 1);
}

function bandColor(bands, ny) {
  return bands[ny < -0.33 ? 0 : (ny > 0.33 ? 2 : 1)];
}

// Weighted pick from a list of {weight, ...} using the seeded rng.
function weightedPick(rng, items) {
  let total = 0;
  for (const it of items) total += it.weight;
  let roll = rng() * total;
  for (const it of items) {
    roll -= it.weight;
    if (roll <= 0) return it;
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// MUTATIONS — helpers. A planet's `mutations` is a list of mutation ids
// (strings) rolled at generation — the planet is BORN with them (Nov 11
// redesign: no tiers, no unlock stages). `activeMutations` is the full
// set: a mutation exists from stage 0, so the player sees it right
// away and can decide to keep the planet or destroy it for minerals.
// The renderer takes the active set; callers that render directly can
// pass it in, or leave it out (defaults to "everything on the planet").
// ---------------------------------------------------------------------------
function mutationDef(id) {
  return CONFIG.MUTATIONS.find(m => m.id === id) || null;
}

// The mutations on this planet — all of them, from stage 0. (No
// stage gating anymore: birth rolls, Nov 11.)
function activeMutations(planet) {
  return new Set(planet.mutations || []);
}

function hasMutation(planet, id) {
  return (planet.mutations || []).includes(id);
}

// The mutation label: "MUTATION · Glitch" — just the name, with a
// MUTATION tag so it's unmissable. No tier (there are no tiers
// anymore). Null when the planet has no mutation. Several mutations
// join with ' + '.
function mutationLabel(planet) {
  const ids = planet.mutations || [];
  if (ids.length === 0) return null;
  const names = ids.map((id) => (mutationDef(id) || { name: id }).name);
  return `MUTATION · ${names.join(' + ')}`;
}

// ---------------------------------------------------------------------------
// SEEDED GENERATOR — seed (number) -> planet traits. Deterministic:
// calling this twice with the same seed gives the exact same planet.
// `tilt` (optional, step 2) biases the birth rolls: { boosts: { mutationId:
// multiplier } } — a fed mineral or prestige inheritance multiplies the
// base chance for those mutations only. Every mutation still draws
// exactly one rng() value, so a tilt never reshuffles the planet's other
// traits (same seed + any tilt = same terrain/rings/moons/size).
// ---------------------------------------------------------------------------
function generatePlanet(seed, starterTerrain, tilt) {
  const rng = mulberry32(seed);
  let terrain;
  if (starterTerrain) {
    // First planet: the starter pick biases the terrain (Devon's choice).
    // 75% it IS the starter terrain, 25% the algorithm surprises you.
    terrain = rng() < 0.75
      ? CONFIG.TERRAINS.find(t => t.id === starterTerrain) || weightedPick(rng, CONFIG.TERRAINS)
      : weightedPick(rng, CONFIG.TERRAINS);
  } else {
    terrain = weightedPick(rng, CONFIG.TERRAINS);
  }
  const atmosphere = weightedPick(rng, CONFIG.ATMOSPHERES);
  const ringType = weightedPick(rng, CONFIG.RING_TYPES);
  const moonCount = weightedPick(rng, CONFIG.MOON_COUNT);
  // Size: the SAME rng draw as before, but shaped — a cubic curve
  // compresses it toward the middle, so huge/tiny planets are rare
  // (base rarity, Nov 11) while the draw order — and everything after
  // it — stays identical. Extreme sizes still happen, just rarely:
  // P(size >= 1.12) drops from ~10% to ~3.6%.
  const sizeU = rng();
  const sizeD = (sizeU - 0.5) * 2; // [-1, 1]
  const sizeShaped = 0.5 + Math.sign(sizeD) * Math.pow(Math.abs(sizeD), 3) / 2;
  const size = CONFIG.SIZE_MIN + sizeShaped * (CONFIG.SIZE_MAX - CONFIG.SIZE_MIN);
  // Moons get their own orbit: radius factor, speed, starting angle.
  // Two passes on purpose: the first rolls orbit/speed/phase (the
  // values older seeds already had — they stay identical), the second
  // rolls the NEW radius/tint traits, and the ring tilt rolls last, so
  // adding these traits never reshuffles the values a seed already had.
  const moons = [];
  for (let i = 0; i < moonCount.n; i++) {
    moons.push({
      orbit: 1.55 + i * 0.35 + rng() * 0.15, // in planet radii
      speed: (0.25 + rng() * 0.35) * (rng() < 0.5 ? 1 : -1),
      phase: rng() * Math.PI * 2,
    });
  }
  for (const m of moons) {
    m.radius = weightedPick(rng, CONFIG.MOON_RADII).radius;
    m.tint = weightedPick(rng, CONFIG.MOON_TINTS).code;
    // The pre-mutation values, so a planet WITHOUT the mutation renders
    // the moon plain — the mutation is a real difference, and a plain
    // twin (same planet, mutations stripped) shows a normal moon.
    m.baseRadius = m.radius;
    m.baseTint = m.tint;
    m.mutantIds = [];
  }
  // Ring tilt: a seeded angle for the ring plane (degrees, signed).
  const tiltBucket = weightedPick(rng, CONFIG.RING_TILT_BUCKETS);
  const ringTilt = (rng() < 0.5 ? -1 : 1)
    * (tiltBucket.min + rng() * (tiltBucket.max - tiltBucket.min));
  // Mutations roll LAST, so every trait above stays identical for
  // existing seeds. One independent seeded roll per mutation, all at
  // the SAME chance (CONFIG.MUTATION_CHANCE) — no tiers, no cap: a
  // planet is born with whatever it rolls, usually nothing, rarely
  // two. A mutation you roll is yours from stage 0. A tilt (step 2:
  // a fed mineral, or prestige inheritance) multiplies the chance
  // for the boosted mutations only — the roll still draws once per
  // mutation, so unboosted mutations and every other trait are
  // untouched by the tilt.
  let mutations = [];
  for (const mut of CONFIG.MUTATIONS) {
    const boost = (tilt && tilt.boosts && tilt.boosts[mut.id]) || 1;
    if (rng() < Math.min(1, CONFIG.MUTATION_CHANCE * boost)) mutations.push(mut.id);
  }
  // Mutation overrides: some mutations GRANT the trait they name, so a
  // planet born with one always shows it — even if its base rolls said
  // no rings / no moons. These consume rng in a FIXED order, so the
  // generation stays deterministic.
  let finalRingType = ringType.id;
  let ringHue = null;   // colored-rings: the vivid ring color (ANSI code)
  let crossTilt = null; // crossed-rings: the second ring's tilt (degrees)
  const ensureMoon = (radius, tint) => {
    // A moon added by a mutation still needs a PLAIN form: the base
    // size and tint are what a planet WITHOUT the mutation shows, so
    // the mutation is a real difference, not baked in. The base tint
    // is a normal moon tint drawn from the base table — never the
    // mutated color (46/196 are not base tints, so baking them into
    // baseTint would make the moon show its mutation color even on a
    // planet without the mutation).
    const baseTint = weightedPick(rng, CONFIG.MOON_TINTS).code;
    const m = {
      orbit: 1.55 + moons.length * 0.35 + rng() * 0.15,
      speed: (0.25 + rng() * 0.35) * (rng() < 0.5 ? 1 : -1),
      phase: rng() * Math.PI * 2,
      radius, tint, baseRadius: radius, baseTint, mutantIds: [],
    };
    moons.push(m);
    return m;
  };
  if (mutations.includes('double-rings')) finalRingType = 'double';
  if (mutations.includes('colored-rings')) {
    if (finalRingType === 'none') finalRingType = 'thin';
    const hues = [201, 93, 51, 46, 196]; // magenta / violet / cyan / green / red
    ringHue = hues[Math.trunc(rng() * hues.length)];
  }
  if (mutations.includes('crossed-rings')) {
    if (finalRingType === 'none') finalRingType = 'thin';
    // The second ring sits 25-55° off the main ring — a clear crossing,
    // but clamped to ±45° so it never goes near-vertical and turns the
    // whole frame into a diagonal mess.
    const rawCross = ringTilt + (rng() < 0.5 ? -1 : 1) * (25 + rng() * 30);
    crossTilt = Math.max(-45, Math.min(45, rawCross));
  }
  if (mutations.includes('big-moon')) {
    if (moons.length === 0) {
      const m = ensureMoon(5.0, 250);
      // The plain form is a NORMAL moon (radius 3.0) — the mutation is
      // the size, so a planet without it must not show a big moon.
      m.baseRadius = 3.0;
      m.mutantIds.push('big-moon');
    } else {
      const big = moons.reduce((a, b) => (a.baseRadius >= b.baseRadius ? a : b));
      big.radius = 5.0;
      big.mutantIds.push('big-moon');
    }
  }
  if (mutations.includes('green-moon')) {
    let target = moons.find(m => !m.mutantIds.includes('green-moon') && !m.mutantIds.includes('blood-moon'));
    if (!target) target = ensureMoon(3.0, 46);
    target.tint = 46; // neon green
    // A colored moon has to READ as colored: a radius-2 moon is ~11
    // cells and mostly dim, so the color only shows on 2-3 of them.
    // Colored moons are at least radius 3 — big enough to see the color.
    target.radius = Math.max(target.radius, 3.0);
    target.mutantIds.push('green-moon');
  }
  if (mutations.includes('blood-moon')) {
    let target = moons.find(m => !m.mutantIds.includes('green-moon') && !m.mutantIds.includes('blood-moon'));
    if (!target) target = ensureMoon(3.0, 196);
    target.tint = 196; // blood red
    target.radius = Math.max(target.radius, 3.0);
    target.mutantIds.push('blood-moon');
  }
  // The summary names the FINAL traits (mutations can grant a ring or
  // a moon the base rolls didn't) — for a planet with no mutations it
  // is exactly the old string.
  const finalRingDef = CONFIG.RING_TYPES.find(rt => rt.id === finalRingType) || ringType;
  const finalRingLabel = finalRingDef.label;
  return {
    seed,
    // The planet's name — tied to the seed, so the same seed always
    // has the same name (step 4). Generated on its own RNG stream,
    // so it never disturbs the trait draws above.
    name: generatePlanetName(seed),
    terrain: terrain.id,
    terrainLabel: terrain.label,
    bands: terrain.bands.slice(), // [dark pole, mid, bright pole] ANSI codes
    atmosphere: atmosphere.code,
    ringType: finalRingType,
    baseRingType: ringType.id, // pre-mutation ring: the renderer gates
    // a ring mutation behind the active set, so a planet without
    // double-rings shows its base ring, not a baked-in double one.
    ringLabel: finalRingLabel,
    ringTilt,
    ringTiltLabel: tiltBucket.label,
    ringHue,
    crossTilt,
    moons,
    size,
    mutations,
    // Human-readable one-liner, e.g. "Icy world · wide ring · 2 moons".
    summary: `${terrain.label} world · ${finalRingLabel.toLowerCase()} · ${moons.length} moon${moons.length === 1 ? '' : 's'}`,
  };
}

// ---------------------------------------------------------------------------
// RENDERER — faithful port of lifecycle.py.
// A grid is a 2D array of [char, ansiColorCode] cells, like Python's
// list of (ch, col) tuples. drawPlanet/drawRingBand mutate the grid.
// ---------------------------------------------------------------------------
const LIGHT_NORM = (() => {
  const l = CONFIG.LIGHT;
  const len = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]);
  return [l[0] / len, l[1] / len, l[2] / len];
})();

function makeGrid() {
  const { W, H } = CONFIG;
  const grid = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) row.push([' ', null]);
    grid.push(row);
  }
  return grid;
}

function starGrid(sec, atmosphere) {
  const grid = makeGrid();
  for (const [sx, sy, sp, ch] of STARS) {
    const tw = 0.5 + 0.5 * Math.sin(sec * 2.0 + sp * 3.0);
    if (tw > 0.25) grid[sy][sx] = [ch, tw > 0.7 ? atmosphere : 244];
  }
  return grid;
}

// Draw one ring band. innerR/outerR are in planet-radius units:
// the band covers radii innerR..outerR. (Python's single band is
// inner 1.25, outer 2.4; "double" draws two of these with a gap.)
function drawRingBand(grid, r, openness, sec, front, ringDef, innerR, outerR, tilt) {
  const { W, H, CX, CY, RAMP } = CONFIG;
  if (openness <= 0.05) return;
  const rx = r * outerR;
  const ry = Math.max(0.6, r * 0.40 * openness);
  const inner = innerR / outerR; // normalized inner edge
  const la = Math.atan2(-0.55, -0.7); // azimuth of the top-left light
  const shattered = ringDef.id === 'shattered';
  const colors = ringDef.colors;
  // Ring tilt (Nov 11): the ring plane is rotated in the image plane
  // by the planet's seeded tilt, so rings are not always perfectly
  // horizontal. The rotation is applied to the SCREEN offset BEFORE
  // normalizing by the ellipse radii: rotating the normalized
  // coordinates would do nothing — a rotation preserves the norm, so
  // the ellipse test would be unchanged. (That was the first attempt's
  // bug: the tilt had no visible effect.) The front/back split follows
  // the tilted major axis (oyr >= 0 is the near side), and the loop
  // bounds cover the rotated ellipse's bounding box.
  const cosT = Math.cos(tilt || 0), sinT = Math.sin(tilt || 0);
  const bbW = rx * Math.abs(cosT) + ry * Math.abs(sinT);
  const bbH = rx * Math.abs(sinT) + ry * Math.abs(cosT);
  const y0 = Math.max(0, Math.floor(CY - bbH) - 1);
  const y1 = Math.min(H, Math.floor(CY + bbH) + 2);
  const x0 = Math.max(0, Math.floor(CX - bbW) - 1);
  const x1 = Math.min(W, Math.floor(CX + bbW) + 1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ox = x - CX, oy = y - CY;
      const oxr = ox * cosT + oy * sinT;
      const oyr = -ox * sinT + oy * cosT;
      const dx = oxr / rx;
      const dy = oyr / ry;
      const rho2 = dx * dx + dy * dy;
      if (rho2 < inner * inner || rho2 > 1.0) continue;
      const rho = Math.sqrt(rho2);
      const theta = Math.atan2(dy, dx); // around the ring (for the wave)
      if (front && oyr < 0) continue;
      if (!front && oyr >= 0) continue;
      if (!front && Math.pow((x - CX) / r, 2) + Math.pow(2 * (y - CY) / r, 2) <= 1.0) continue;
      // Cassini-style gap: sparse dark glyphs. Shattered rings: wider gap.
      const gapLo = shattered ? 0.66 : 0.72, gapHi = shattered ? 0.84 : 0.78;
      if (rho > gapLo && rho < gapHi) {
        if (noise2(x, y, sec * 2.0 + 7.0) > 0.35) continue;
        grid[y][x] = ['.', 238];
        continue;
      }
      // Outer edge frays out. Shattered rings fray much more.
      const frayAt = shattered ? 0.30 : 0.5;
      if (rho > 0.98 && noise2(x, y, sec * 2.0 + 8.0) > frayAt) continue;
      // Ring particles orbit: a brightness wave travels around it.
      const wave = 0.5 + 0.5 * Math.sin(theta * 6.0 - sec * 2.2);
      // 3D light: the side toward the top-left light is brighter.
      const lit = 0.65 + 0.35 * Math.cos(theta - la);
      let b = ((0.82 - 0.25 * rho) * lit + (wave - 0.5) * 0.25
        + (noise2(x, y, sec * 8.0) - 0.5) * 0.10);
      if (!front) {
        // The planet's shadow falls on the back ring by the disc.
        const dDisc = Math.pow((x - CX) / r, 2) + Math.pow(2 * (y - CY) / r, 2);
        if (dDisc < 1.44) b *= 0.6;
      }
      b = clamp(b, 0.0, 1.0);
      const ch = RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.trunc(b * RAMP.length)))];
      let base;
      if (front) base = rho < 0.7 ? colors[0] : (rho < 0.88 ? colors[1] : colors[2]);
      else base = rho < 0.8 ? colors[3] : colors[4];
      // Rings shade like the body: scale the gold by the ring's own
      // brightness so the far side and the planet's shadow read dim.
      // Tint is 1.0 — full gold, scaled by light (the rings are the
      // warm accent; their color stays, only their brightness follows
      // the light).
      const col = shadeColor(base, 0.25 + 0.75 * b, CONFIG.RING_TINT);
      grid[y][x] = [ch, col];
    }
  }
}

function drawRings(grid, r, openness, sec, front, planet, muts) {
  // The ring that actually shows: a ring mutation is gated behind the
  // active set, so a planet without it shows its BASE ring. Double
  // Rings replaces the base ring; Colored/Crossed Rings grant a thin
  // ring when the planet rolled none. (Before Nov 11 the mutated type
  // was baked into planet.ringType, so a plain twin rendered double
  // rings too — the mutation was invisible as a mutation.)
  const active = muts || new Set(planet.mutations || []);
  let effId = planet.baseRingType || planet.ringType;
  if (active.has('double-rings')) effId = 'double';
  else if ((active.has('colored-rings') || active.has('crossed-rings')) && effId === 'none') effId = 'thin';
  const ringDef = CONFIG.RING_TYPES.find(rt => rt.id === effId) || CONFIG.RING_TYPES[2];
  if (ringDef.id === 'none' || !ringDef.colors) return;
  const tilt = ((planet.ringTilt || 0) * Math.PI) / 180; // degrees -> radians
  // Colored rings: the ring's gold is replaced by the planet's seeded
  // vivid hue (magenta / violet / cyan / green / red), with lighter
  // tints toward the outer edge and darker ones on the far side — the
  // same shading shape as the gold rings, a different color.
  let def = ringDef;
  if (active.has('colored-rings') && planet.ringHue) {
    const h = planet.ringHue;
    def = { ...ringDef, colors: [
      h, blendHue(h, 250, 0.30), blendHue(h, 250, 0.55),
      blendHue(h, 16, 0.55), blendHue(h, 16, 0.70),
    ] };
  }
  if (def.id === 'double') {
    // Two bands with a real gap between them: 1.25–1.70 and 1.95–2.45.
    drawRingBand(grid, r, openness, sec, front, def, 1.25, 1.70, tilt);
    drawRingBand(grid, r, openness, sec, front, def, 1.95, 2.45, tilt);
  } else {
    drawRingBand(grid, r, openness, sec, front, def, 1.25, def.outer, tilt);
  }
  // Crossed rings: a SECOND, thinner ring at a different tilt, so the
  // two rings cross each other near the disc. Dimmer than the main ring
  // so the crossing reads instead of mushing together.
  if (active.has('crossed-rings') && planet.crossTilt !== null && planet.crossTilt !== undefined) {
    const tilt2 = (planet.crossTilt * Math.PI) / 180;
    const dim = { ...def, colors: def.colors.map(c => blendHue(c, 16, 0.35)) };
    drawRingBand(grid, r, openness, sec, front, dim, 1.35, 2.0, tilt2);
  }
}

// Explosion fragments for the stage-0 'exploded' look: 14 chunks with a
// seeded angle, starting radius, outward speed, size and hot tint.
// Built once per frame from the planet's seed — deterministic, so the
// same planet always bursts the same way. Each fragment also ORBITS
// (its angle advances with sec) so the ring visibly turns, and ~50%
// of fragments are MUTANT — iridescent hues (cyan / purple /
// violet / green) mixed in with the hot reds and oranges, so the ring
// reads as a mutated planet's debris, not ordinary rock.
function buildFragments(seed) {
  const frng = mulberry32((seed + 777) >>> 0);
  const frags = [];
  const hotTints = [202, 196, 214, 124];
  const mutantTints = [51, 93, 129, 46];
  for (let i = 0; i < 14; i++) {
    const mutant = frng() < 0.5;
    frags.push({
      ang: frng() * Math.PI * 2,
      base: 0.45 + frng() * 0.35,
      speed: 0.05 + frng() * 0.10,
      size: 1.0 + frng() * 1.5,
      tint: mutant
        ? mutantTints[Math.trunc(frng() * mutantTints.length)]
        : hotTints[Math.trunc(frng() * hotTints.length)],
      mutant,
      // Orbit: angle advances with sec (0.10–0.35 rad/s, either
      // direction) — the fragments spiral outward as they turn.
      spin: (0.10 + frng() * 0.25) * (frng() < 0.5 ? 1 : -1),
      // Start offset: fragments are already spread across the full
      // flight at sec 0, so the explosion reads immediately instead
      // of starting as a bare core with everything hidden inside it.
      phase: frng() * 1.1,
    });
  }
  return frags;
}

// Smoke plumes for the stage-0 'exploded' look (Nov 11, smoke
// redesign — Devon: the old wisps looked like the ring slowly
// breaking off, not smoke from the sphere). A wisp is now a PLUME
// anchored at the core surface: it grows outward along its angle as
// it ages, brightest at the core and dissolving with distance, its
// edges frayed by seeded noise — soft haze, not chunks. 20 small
// wisps, not 12 big ones; they fly off noticeably quicker (a full
// growth in ~2-3s, so the burst reads as energetic in a 2s clip).
// Each wisp knows its depth: `far` = top half of the disc (the far
// side of the ring) — far smoke is drawn before the ring and occluded
// by it, near smoke after the ring and in front of it.
function buildSmoke(seed) {
  const srng = mulberry32((seed + 31337) >>> 0);
  const puffs = [];
  for (let i = 0; i < 20; i++) {
    const ang = srng() * Math.PI * 2; // full circle — every direction
    puffs.push({
      ang,
      far: Math.sin(ang) < 0,          // top half = far side of the ring
      speed: 0.30 + srng() * 0.25,     // growth rate (cycles/sec) — quick
      reach: 1.0 + srng() * 0.4,       // how far the tip gets (radius units)
      wid0: 0.7 + srng() * 0.5,        // plume width at the core (cells)
      spread: 0.06 + srng() * 0.06,    // width growth per cell of length
      dens: 0.18 + srng() * 0.10,      // peak brightness — dim, soft haze
      tint: [238, 242, 244][Math.trunc(srng() * 3)],
      patch: Math.trunc(srng() * 100), // noise offset — each plume frays differently
      phase: srng() * 1.0,
    });
  }
  return puffs;
}

// One smoke-plume cell (Nov 11 smoke redesign): returns [ch, color]
// for the cell (x, y) if a plume covers it, else null. `far` picks
// far-side (top-half) or near-side (bottom-half) plumes; null = both
// (used for the plume base in the halo annulus, where there is no
// ring to be in front of or behind). The plume is a streak along the
// radial from the core rim outward: its tip grows with the wisp's
// life h (0 -> 1), it widens as it goes, and it is brightest at the
// core, dissolving with distance. Edges are frayed by seeded noise
// so it reads as haze, not a solid chunk. Only the dim end of the
// ramp ('.' and ',') and dim greys — never a saturated color.
function smokeCellAt(x, y, r, radN, smoke, sec, seed, far) {
  const { CX, CY } = CONFIG;
  const ox = x - CX, oy = y - CY;
  for (const p of smoke) {
    if (far !== null && p.far !== far) continue;
    const h = pymod(sec * p.speed + p.phase, 1.0);
    const tipN = 0.6 + h * p.reach;
    if (radN > tipN) continue; // the plume hasn't grown this far yet
    const co = Math.cos(p.ang), si = Math.sin(p.ang);
    const cl = Math.sqrt(co * co + 0.25 * si * si);
    const urx = co / cl, ury = 0.5 * si / cl;
    const utx = -ury, uty = urx;
    const along = ox * urx + oy * ury;
    const rimAlong = 0.6 * r * cl;
    const tipAlong = tipN * r * cl;
    if (along < rimAlong || along > tipAlong) continue;
    const across = ox * utx + oy * uty;
    const wid = p.wid0 + (along - rimAlong) * p.spread;
    if (Math.abs(across) >= wid) continue;
    const dist = (along - rimAlong) / Math.max(1, tipAlong - rimAlong);
    const edge = 1 - (across / wid) * (across / wid);
    // Frayed edges: seeded noise along the plume so it isn't a
    // uniform streak — patchy, dissolving haze.
    const patch = 0.55 + 0.45 * noise2(Math.floor(along * 0.6) + p.patch, Math.floor(across * 1.5), seed + 77);
    const b = p.dens * (1 - dist * 0.85) * edge * patch;
    if (b < 0.05) continue;
    return [b > 0.13 ? '.' : ',', shadeColor(p.tint, b, 1.0)];
  }
  return null;
}

// Multicolor sparkles BURSTING out of the core (Nov 11, Devon's
// correction — the "it's mutated" signal, and the eye-catching part):
// 10 seeded sparkles in varied hues (hot + mutant colors)
// that fly outward from the core edge, each twinkling on its own
// rhythm, so the burst shimmers in many colors at once.
function buildSparkles(seed) {
  const grng = mulberry32((seed + 9001) >>> 0);
  const hues = [226, 202, 51, 93, 129, 46, 214, 165];
  const sparks = [];
  for (let i = 0; i < 10; i++) {
    sparks.push({
      ang: grng() * Math.PI * 2,
      base: 0.9 + grng() * 0.3,
      speed: 0.08 + grng() * 0.12,
      hue: hues[Math.trunc(grng() * hues.length)],
      // Twinkle phase: each sparkle blinks on its own rhythm.
      tw: grng() * 10,
      phase: grng() * 1.0,
    });
  }
  return sparks;
}

// Two rotating surface characters on the stage-0 'exploded' core
// (Nov 11, Devon's fix — the pulse alone doesn't read as rotation, so
// a couple of characters rotate like the other stages). Two seeded
// ember patches ride the core's surface: their longitude advances at
// the core's spin rate, so they sweep across the disc, fade at the
// limb and vanish behind it, then come around again — the spin reads.
// NOT the old white-hot spot (it wandered off to the side and read as
// a separate object): these stay well inside the disc (|u| <= 0.7) and
// use the core's own hot hues, just slightly brighter than the cells
// around them. NOT magma veins either. A rigid sphere has one spin
// rate, so both markers share it.
function buildCoreMarkers(seed) {
  const mrng = mulberry32((seed + 4242) >>> 0);
  const spin = 0.5 + mrng() * 0.4; // rad/s — a full turn in ~7-12s
  // Antipodal pair: the second marker sits exactly opposite the
  // first, so at any moment one of them is on the near side — the
  // spin always has a visible character. The first starts near the
  // front of the disc (lon0 in [-0.6, 0.1], clamped so the limb
  // handoff lands after 2.2s — through the 2s clip both markers are
  // well placed, not mid-handoff).
  let lon0 = -0.6 + mrng() * 0.7;
  lon0 = Math.min(lon0, Math.PI / 2 - 2.2 * spin);
  const marks = [
    { lon0, lat: (mrng() - 0.5) * 0.9 }, // |v| <= 0.45 — inside the disc
    { lon0: lon0 + Math.PI, lat: (mrng() - 0.5) * 0.9 },
  ];
  return { spin, marks };
}

// Screen position of one core marker at time sec (grid coords), or
// null when it is behind the core. r = the stage radius in cells.
// `vis` is cos(lon): full strength at the center of the disc, fading
// to nothing at the limb, so the marker dims as it rounds the edge
// instead of popping off.
function coreMarkerAt(marker, spin, sec, r) {
  const lon = marker.lon0 + sec * spin;
  const cosLon = Math.cos(lon);
  if (cosLon <= 0) return null; // behind the core
  const u = 0.7 * Math.cos(marker.lat) * Math.sin(lon);
  const v = Math.sin(marker.lat);
  const { CX, CY } = CONFIG;
  return {
    x: CX + u * 0.6 * r,
    y: CY + v * 0.6 * r / 2,
    vis: cosLon,
  };
}

function drawPlanet(grid, st, r, sec, planet, fade, stage0Style, muts) {
  if (stage0Style === undefined) stage0Style = 'exploded';
  const { CX, CY, RAMP } = CONFIG;
  const mode = st.mode;
  // The mutations on this planet — all of them, from stage 0 (birth
  // rolls). Callers that render directly may omit `muts`.
  const activeMuts = muts || activeMutations(planet);
  const [freq, bump] = st.pat;
  const [lx, ly, lz] = LIGHT_NORM;
  const bands = planet.bands; // the planet's terrain colors replace the stage's
  const seed = planet.seed || 0; // every generated planet has one; tests may not
  // The storm's home: a FIXED texture longitude/latitude for this planet
  // (seeded, so every planet's storm lives somewhere different). It is
  // hoisted out of the per-cell loop — it never changes within a frame.
  const stormX = (noise2(0.0, 0.0, seed) - 0.5) * 1.4;
  const stormY = (noise2(5.0, 5.0, seed) - 0.5) * 0.5;
  // Explosion fragments (stage-0 'exploded' only): a FIXED set of chunks
  // per planet, seeded from the planet's seed — same fragments every
  // frame, only their radius grows with sec (they fly outward, then
  // cycle back to the core as fresh debris, so the loop never empties).
  // Same for the smoke puffs and the bursting sparkles.
  const exploded = (mode === 'dust' && stage0Style === 'exploded');
  const frags = exploded ? buildFragments(seed) : null;
  const smoke = exploded ? buildSmoke(seed) : null;
  const sparks = exploded ? buildSparkles(seed) : null;
  const coreMarkers = exploded ? buildCoreMarkers(seed) : null;
  // Ring color blending (Nov 11): each fragment knows the NEXT
  // fragment around the ring (by CURRENT angle — they orbit at
  // different rates), so its cells can flow into the neighbor's
  // tint instead of sitting as one solid color.
  if (exploded) {
    const order = frags.map((f, i) => i).sort((a, b) =>
      (frags[a].ang + sec * frags[a].spin) - (frags[b].ang + sec * frags[b].spin));
    for (let k = 0; k < order.length; k++) {
      frags[order[k]].next = frags[order[(k + 1) % order.length]];
    }
  }
  // Stage-0 'exploded' pulse: the core breathes — a SLOW, DEEP glow
  // swell across the WHOLE disc (~3.5s cycle). Computed once per frame.
  // (Nov 11, Devon: the old ~1.6s / ±0.15 pulse was a violent flash,
  // not gradual — the dark side swung ~77 lum and slammed to
  // full-bright `0` glyphs. And the pulse has to be EVEN: lit and dark
  // breathing together as one dangerous molten core, like a slow
  // heartbeat — the whole disc glowing hot at the peak and settling
  // back at the trough. So the pulse has two parts on the same cycle:
  // a small multiplier (every cell dims a little at the trough) and an
  // additive glow swell (the same absolute brightness delta everywhere,
  // weighted a bit toward the dark side so the dim side moves too).
  // Both stay modest — no flashing to full bright.)
  const pulsePhase = Math.sin(sec * (2 * Math.PI / 3.5));
  const pulse = 0.98 + 0.02 * pulsePhase; // multiplier, ±0.02
  // Stage-0 variants spread wider than the stage radius (a nebula cloud
  // and explosion debris extend past the disc-to-be), so the loop bounds
  // widen for them. Other stages are untouched.
  const effR = (mode === 'dust' && stage0Style !== 'dust') ? r * 2.0 : r;
  const y0 = Math.max(0, Math.floor(CY - effR - 1));
  const y1 = Math.min(CONFIG.H, Math.floor(CY + effR) + 2);
  const x0 = Math.max(0, Math.floor(CX - effR - 1));
  const x1 = Math.min(CONFIG.W, Math.floor(CX + effR) + 2);
  // Smoke depth tracking (Nov 11 smoke redesign): which cells hold
  // far smoke / fragments / sparkles / debris, so the far/near smoke
  // passes and the debris ring layer correctly — far smoke behind the
  // ring, near smoke in front of it. Per frame, only used in the
  // stage-0 exploded branch. Keys are y * W + x.
  const farSmoke = new Set(), fragCells = new Set(), sparkCells = new Set(), debrisCells = new Set();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const sx = (x - CX) / r;
      const sy = (y - CY) / r;
      const d2 = sx * sx + Math.pow(2 * sy, 2);
      if (mode === 'dust') {
        if (stage0Style === 'nebula') {
          // GLOWING NEBULA (Nov 11): a dense swirl of gas and dust
          // visibly pulling together — the first thing people see, so
          // it has to hook them. A spiral inflow: the arms rotate
          // (their angle advances with sec) and wind inward (their
          // radius shrinks as sec grows), like water down a drain — a
          // steady spiral flow, not a collapse. Dense glowing center,
          // fading wisps at the edge; warm gold core + cool outer
          // wisps in the planet's atmosphere tint; clumps seeded per
          // planet so every planet's nebula is different.
          const radN = Math.sqrt(d2);
          if (radN > 1.6) continue;
          const ang = Math.atan2(2 * sy, sx);
          const arm = Math.sin(2 * ang - 3 * radN - sec * 0.9);
          // Clumps rotate WITH the arms (same 0.45 rad/s angular rate).
          const angC = ang - sec * 0.45;
          const clump = valueNoise((angC / (2 * Math.PI)) * 8, radN * 4, seed + 517, 8);
          // Gentle falloff (the cloud stays dense well past the disc-to-be)
          // and a bright mapping: the core glows hard, the wisps stay
          // visible. The first version fell off too steeply and read as
          // a small dim disc instead of a glowing cloud.
          const fall = 1 - 0.55 * (radN / 1.6);
          let dens = fall * (0.55 + 0.45 * arm) * (0.65 + 0.35 * clump);
          dens *= (0.4 + 0.6 * fade);
          const bright = clamp(dens * 1.7 + (radN < 0.55 ? 0.25 * (1 - radN / 0.55) : 0), 0, 1);
          if (dens > 0.30) {
            const ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(bright * RAMP.length))];
            const hue = radN < 0.8 ? (bright > 0.7 ? 226 : 202) : planet.atmosphere;
            grid[y][x] = [ch, shadeColor(hue, bright, 1.0)];
          } else if (dens > 0.15 && clump > 0.75) {
            // Sparse outer wisps.
            grid[y][x] = ['.', shadeColor(planet.atmosphere, 0.22, 1.0)];
          }
          continue;
        }
        if (stage0Style === 'exploded') {
          // EXPLODED PLANET (Nov 11): a world that just burst apart —
          // a bright molten core, glowing fragments flying outward,
          // a faint debris ring. The fragments cycle: they fly out
          // and reappear at the core as fresh debris, so the looping
          // preview never empties. (Devon, Nov 11: the ring has to
          // MOVE and its mutation colors have to BLEND into each
          // other, the smoke has to RADIATE outward from the core in
          // all directions and fade into space, and the core
          // pulses. No hot spot on the core — it read as a separate
          // object off to the side. No magma veins: they still look
          // bad on the crust stage.)
          const radN = Math.sqrt(d2);
          if (radN > 2.0) continue;
          if (radN <= 0.6) {
            // Molten core: a small hot sphere with the same fixed
            // top-left light as the planet, so it reads 3D. It
            // PULSES (slow gentle breathing glow, ~3.5s cycle) — and the
            // WHOLE core breathes, dark side included (Nov 11:
            // the pulse only showed on the lit side, which didn't
            // make sense for a glowing core). Two ember patches
            // rotate on its surface, so the spin reads (Nov 11:
            // the pulse alone didn't read as rotation). NOT the old
            // white-hot spot (it read as a separate object off to
            // the side) and NOT magma veins — just a couple of
            // slightly brighter surface characters, well inside
            // the disc, in the core's own hues.
            const csx = sx / 0.6, cpy = (2 * sy) / 0.6;
            const csz = Math.sqrt(Math.max(0, 1.0 - csx * csx - cpy * cpy));
            const cb = clamp(csx * lx + cpy * ly + csz * lz, 0, 1);
            // Whole-core pulse: the glow swell is even across the disc
            // — an additive term (the same absolute delta everywhere,
            // a little stronger toward the dark side) plus the small
            // multiplier above. Lit and dark breathe in the same
            // cycle, as one core; at the peak the whole disc reads
            // hotter, at the trough it settles back. GENTLE: the dark
            // side swings only ~15-25 lum, never flashing to full
            // bright `0` glyphs (Nov 11: the old ±0.15 pulse was a
            // violent flash).
            const pulseGlow = 0.06 * pulsePhase; // ±0.06 additive swell
            let coreB = clamp(0.35 + 0.65 * cb + pulseGlow * (1.5 - cb), 0, 1);
            for (const mk of coreMarkers.marks) {
              const pos = coreMarkerAt(mk, coreMarkers.spin, sec, r);
              if (!pos) continue; // behind the core
              const mdx = x - pos.x, mdy = y - pos.y;
              if (mdx * mdx + mdy * mdy < 1.2) {
                coreB = clamp(coreB + 0.18 * pos.vis, 0, 1);
                break;
              }
            }
            coreB *= pulse;
            const ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(coreB * RAMP.length))];
            const hue = coreB > 0.75 ? 226 : (coreB > 0.45 ? 214 : 202);
            grid[y][x] = [ch, shadeColor(hue, coreB, 1.0)];
            continue;
          }
          if (radN <= 0.9) {
            // Glow halo just outside the core, brighter on the lit side,
            // breathing with the same pulse as the core.
            const haloB = clamp((0.9 - radN) * 1.2, 0, 1) * 0.5 * pulse;
            const angH = Math.atan2(2 * sy, sx);
            const flick = 0.7 + 0.3 * noise2(Math.floor(angH * 4), 0, seed + 41);
            if (haloB * flick > 0.12) {
              grid[y][x] = ['.', shadeColor(202, haloB * flick, 1.0)];
            }
            // Smoke base (Nov 11 smoke redesign): the plumes start AT
            // the core surface — draw them over the faint halo so the
            // smoke visibly leaves the sphere instead of appearing
            // out at the ring. No ring inside this annulus, so depth
            // doesn't apply here; both sides draw.
            const sc = smokeCellAt(x, y, r, radN, smoke, sec, seed, null);
            if (sc) grid[y][x] = sc;
            continue;
          }
          // Depth-aware smoke (Nov 11 smoke redesign): far-side smoke
          // (top half) is drawn BEFORE the ring, so the fragments and
          // the debris ring occlude it — it passes BEHIND the ring.
          const key = y * CONFIG.W + x;
          const farCell = smokeCellAt(x, y, r, radN, smoke, sec, seed, true);
          if (farCell) { grid[y][x] = farCell; farSmoke.add(key); }
          // Fragments: glowing chunks flying outward from the core
          // AND orbiting around it — their angle advances with sec,
          // so the ring visibly turns as the debris spirals out.
          // A brightness wave travels around the ring with them.
          // They overwrite far smoke where they overlap (in front of it).
          for (const f of frags) {
            const frad = f.base + pymod(sec * f.speed + f.phase, 1.1);
            const fang = f.ang + sec * f.spin;
            const fx = CX + frad * r * Math.cos(fang);
            const fy = CY + frad * r * 0.5 * Math.sin(fang);
            const fdx = (x - fx) / f.size, fdy = (y - fy) / (f.size * 0.5);
            if (fdx * fdx + fdy * fdy > 1.0) continue;
            // Cooler (dimmer) as they fly out; brighter where the
            // travelling wave passes.
            const wave = 0.8 + 0.2 * Math.sin(fang * 2 - sec * 1.4);
            const fb = clamp((1.15 - frad * 0.55) * wave, 0.15, 1.0);
            const ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(fb * RAMP.length))];
            // Blend toward the next fragment's tint across this
            // fragment's cells: cells on the side facing the next
            // fragment take more of its color, so the ring's hues
            // flow into each other instead of sitting as solid blocks.
            const nf = f.next;
            const nrad = nf.base + pymod(sec * nf.speed + nf.phase, 1.1);
            const nang = nf.ang + sec * nf.spin;
            const nx = CX + nrad * r * Math.cos(nang);
            const ny = CY + nrad * r * 0.5 * Math.sin(nang);
            const dang = Math.atan2((ny - fy) / (f.size * 0.5), (nx - fx) / f.size);
            const cang = Math.atan2(fdy, fdx);
            const bt = (0.5 + 0.5 * Math.cos(cang - dang)) * 0.65;
            grid[y][x] = [ch, shadeColor(blendHue(f.tint, nf.tint, bt), fb, 1.0)];
            fragCells.add(key);
            break; // first fragment wins; fragments rarely overlap
          }
          // Multicolor sparkles bursting out of the core: seeded
          // varied hues, flying outward, each twinkling on its own
          // rhythm — the eye-catching "it's mutated" signal.
          // They draw on empty cells, or over far smoke (sparkles are
          // foreground); never over a fragment.
          if (grid[y][x][1] === null || (farSmoke.has(key) && !fragCells.has(key))) {
            for (const sp of sparks) {
              const srad = sp.base + pymod(sec * sp.speed + sp.phase, 1.0);
              const sang = sp.ang + sec * 0.12;
              const sxp = CX + srad * r * Math.cos(sang);
              const syp = CY + srad * r * 0.5 * Math.sin(sang);
              const spdx = (x - sxp) / 1.0, spdy = (y - syp) / 0.5;
              if (spdx * spdx + spdy * spdy > 1.0) continue;
              // Twinkle: on ~3/4 of the time, on its own phase.
              if (Math.trunc(sec * 2 + sp.tw) % 4 === 0) continue;
              const sb = clamp(1.1 - srad * 0.45, 0.25, 1.0);
              const ch = sb > 0.7 ? '*' : (sb > 0.45 ? '+' : '.');
              grid[y][x] = [ch, shadeColor(sp.hue, sb, 1.0)];
              sparkCells.add(key);
              break;
            }
          }
          // Debris ring: a sparse dotted ring, slowly rotating, with
          // a brightness wave travelling around it and a slow hue
          // drift through the mutation colors. It draws on empty
          // cells, or over far smoke only — the ring passes in front
          // of far-side smoke, never over a fragment or sparkle.
          if (Math.abs(radN - 1.1) < 0.06
              && (grid[y][x][1] === null
                || (farSmoke.has(key) && !fragCells.has(key) && !sparkCells.has(key)))) {
            const angR = Math.atan2(2 * sy, sx) - sec * 0.15;
            const rn = noise2(Math.floor(angR * 8), 3, seed + 31);
            if (rn > 0.45) {
              const wave = 0.7 + 0.3 * Math.sin(angR * 3 - sec * 1.5);
              // Smooth hue drift (Nov 11): the hue glides through
              // the mutation colors instead of stepping between
              // solid blocks along the ring.
              const ringHues = [51, 93, 129, 180];
              const hpos = pymod(angR * 2 + sec * 0.3, 4);
              const hi0 = Math.floor(hpos), hi1 = (hi0 + 1) % ringHues.length;
              const hue = blendHue(ringHues[hi0], ringHues[hi1], hpos - hi0);
              grid[y][x] = [rn > 0.8 ? '*' : (rn > 0.6 ? '+' : '.'), shadeColor(hue, (0.3 + 0.4 * rn) * wave, 1.0)];
              debrisCells.add(key);
            }
          }
          // NEAR smoke (Nov 11 smoke redesign): bottom-half wisps,
          // drawn AFTER the ring — they pass IN FRONT of it. They
          // may cover fragment and debris-ring cells, but never a
          // sparkle. This is the depth cue on the near side: the
          // smoke crosses over the ring instead of peeling off it.
          const nearCell = smokeCellAt(x, y, r, radN, smoke, sec, seed, false);
          if (nearCell && (grid[y][x][1] === null || fragCells.has(key) || debrisCells.has(key))) {
            grid[y][x] = nearCell;
          }
          continue;
        }
        if (d2 > 1.3) continue;
        const dens = ((1.0 - d2 / 1.3) * 0.55
          + noise2(x - sec * 1.5, y, 1.0) * 0.45) * (0.4 + 0.6 * fade);
        if (dens > 0.62) {
          const ch = '.*,'[Math.trunc(noise2(x, y, 2.0) * 3)];
          const col = dens > 0.8 ? 250 : (dens > 0.7 ? 244 : 67);
          grid[y][x] = [ch, col];
        }
        continue;
      }
      if (d2 > 1.0) continue;
      const sz = Math.sqrt(1.0 - d2);
      const py = 2 * sy;
      let b = sx * lx + py * ly + sz * lz; // dot with the fixed light
      if (b < 0) b = -b * 0.15; // night side: dim, not black
      // Soft light (restyle, Nov 11): a half-strength smoothstep softens
      // the terminator so the light falls off gradually instead of
      // cutting hard across the disc.
      b = lerp(b, b * b * (3 - 2 * b), 0.5);
      const dif = b; // pre-pattern diffuse, for the rim check below
      // The spin illusion: texture drifts across the fixed disc and
      // every cell flickers its glyph in place each frame.
      const sxd = sx - sec * 0.30;
      // ONE drifting texture coordinate for the whole surface (Nov 11):
      // tx = texture longitude — it drifts at the spin rate, so every
      // surface feature sampled from (tx, ty) rotates together.
      // ty = latitude — it never moves (the planet spins about a
      // vertical axis, so a feature keeps its latitude). The LIGHT stays
      // in screen space (sx, py): fixed sun, rotating planet. Nothing
      // on the surface may use screen x/y or raw sec — that was the bug:
      // the waves, belts and storm were sampled in screen space, so they
      // stood still (or wobbled in place) while the terrain drifted.
      const tx = sxd, ty = py;
      // Drifting cell coordinates, for the sin-hash speckles: the same
      // cell grid as the screen, but sliding with the texture. Quantize
      // with Math.floor when sampling so each texture cell is a stable
      // surface feature that rotates, not a twinkling hash.
      const cx = tx * r, cy = ty * r * 0.5;
      const pat = (Math.sin(sxd * 7 * freq) + Math.sin(py * 9 * freq)
        + Math.sin((sxd + py) * 14 * freq) * 0.5) / 2.5;
      b = clamp(b + Math.max(0.0, pat) * bump);
      b += (noise2(x, y, sec * 8.0) - 0.5) * 0.10;
      // Wide limb fade (the reel's rule, round 2): the disc dissolves
      // into black over a WIDE band, not a 1-2 cell edge. limb goes 0 at
      // the exact edge -> 1 about 20% of the radius in, with a smoothstep
      // so the falloff is gradual. Round 1 faded only the outer ~5% of
      // the radius (sz < 0.30) — that read as a hard ring, not a dissolve.
      const limbRaw = clamp(sz / 0.55, 0.0, 1.0);
      const limb = limbRaw * limbRaw * (3 - 2 * limbRaw); // smoothstep
      b *= (0.05 + 0.95 * limb);
      // Limb glow (reel: body = lit * fill + limb(r, t) * 0.9) — a soft
      // ADDITIVE glow hugging the edge, strongest right at the limb and
      // fading inward, brighter on the lit side. This replaces the old
      // hard rim boost: it is a glow term, not a brightness bump. Added
      // after the fade multiply, before the dropout — the surviving
      // edge cells glow while the dropped ones stay gone: a sparse
      // glowing rim, like the reel's dissolving edge.
      const glow = 0.9 * Math.exp(-(((sz - 0.08) / 0.10) ** 2)) * (0.25 + 0.75 * clamp(dif, 0, 1));
      b += glow;
      // Sparse dropout near the edge: the closer to the limb, the more
      // cells vanish entirely, so the edge melts instead of ending in
      // a hard ring. Fixed noise seed, so the edge shape is stable —
      // only the glyphs flicker, like the reel.
      if (sz < 0.20 && noise2(x, y, 4.0) > 0.55 + sz) continue;
      b = clamp(b * fade, 0.0, 1.0);
      let ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(b * RAMP.length))];
      const ny = sy;
      // Brightness-first color (round 2): the glyph (picked from
      // brightness above) carries the shading; the cell's color is its
      // terrain hue SCALED IN LIGHTNESS by the brightness — lit side
      // bright, night side dark, same hue and saturation everywhere
      // (Devon's correction, Nov 11: keep our colors, borrow only the
      // reel's shading style — never wash them down). Emissive details
      // (city lights, embers) bypass the scaling and keep their full
      // color — they are lights, not surface. Lava cracks used to be
      // emissive too, but that made them a flat bright lattice over
      // the sphere; now they are shaded by the same brightness field
      // as the surface (see the crust block below).
      let hue = bandColor(bands, ny);
      let emissive = false;
      // Crust cracks: a brightness override for the final color step.
      // -1 = not a crack (the surface uses b as usual); >= 0 = a crack
      // cell, shaded by crackB instead of b (see the crust block).
      let crackB = -1;
      // Mutation glow override (piece 3): like crackB, but for the
      // mutation surface effects (crystal crust, sparkling surface,
      // glowing oceans) — a cell the mutation lights up is shaded by
      // glowB instead of b. Checked before crackB: a crystal on a
      // crack reads as a crystal.
      let glowB = -1;
      // Land blend (Life stage only): how much of this cell is continent
      // (0 = ocean, 1 = deep land) and which green it is. Applied at the
      // end as an RGB blend so the coast feathers instead of cutting.
      let landAmt = 0, landHue = 0;
      if (mode === 'molten') {
        // Lava keeps its heat: hotter (brighter) = yellower, cooler = red.
        hue = b > 0.72 ? 226 : (b > 0.5 ? 214 : (b > 0.3 ? 202 : (b > 0.12 ? 196 : 88)));
      } else if (mode === 'rock') {
        const edgeR = 0.82 + 0.3 * noise2((Math.atan2(py, sx) + sec * 0.25) * 2.0, 0.0, 5.0);
        if (d2 > edgeR * edgeR) continue;
      } else if (mode === 'crust') {
        // Lava cracks: ORGANIC fractures that live ON the sphere.
        // The old version was emissive — full uniform orange, glyph
        // from b + 0.5, hue flashing 202/196 in lockstep every 1/3s —
        // on a regular sine lattice. It read as a flat bright "chain
        // link fence" sliding over the disc (Devon, Nov 11). Two
        // fixes: (1) the crack's brightness is a function of the
        // local field b, so it is hot and bright on the lit side,
        // dims toward the limb, and stays ember-dim (never invisible)
        // on the night side; (2) the mask is wobbled by seeded value
        // noise in TEXTURE space (tx, ty), so width and heat vary
        // along each fracture and the lattice breaks into irregular
        // cracks. `pat` is already in texture space, so the cracks
        // keep drifting with the surface exactly as before.
        const crackNoise = valueNoise(tx * 2.5, ty * 2.5, seed + 411, 10);
        const warp = valueNoise(tx * 4, ty * 4, seed + 913, 16);
        const width = 0.025 + 0.085 * crackNoise; // 0.025..0.11, varies along the line
        const patW = pat + (warp - 0.5) * 0.35; // wobble the zero-crossings
        if (Math.abs(patW) < width) {
          // Heat varies per fracture: wide cracks run hotter.
          const heat = 0.55 + 0.45 * crackNoise;
          const cb = clamp((b * 1.25 + 0.12) * heat, 0.10, 1.0);
          ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(cb * RAMP.length))];
          // Hue varies per fracture, with a slow per-cell shimmer —
          // the old global sec*3 flip made the whole network flash
          // in unison.
          hue = Math.trunc(sec * 2 + crackNoise * 8) % 2 === 0 ? 202 : 196;
          crackB = cb; // final color shades the crack by cb, not by b
        }
      } else if (mode === 'ocean') {
        // Waves ride the texture (tx, ty) — they used to be sampled
        // from screen x with a time phase, so they shimmered in place
        // instead of rotating with the planet.
        if (Math.abs(Math.sin(tx * 15.0) + ty * 1.4) < 0.25 && b > 0.25) {
          ch = '~'; hue = 51;
        }
        // Speckles: the same sin-hash dots as before, but sampled in
        // the drifting texture cells (cx, cy) at the texture's rate and
        // seeded per planet — the old version drifted at 3 cells/s
        // (about a third of the terrain's rate) in screen y.
        if (noise2(Math.floor(cx), Math.floor(cy), seed) > 0.74 && b > 0.35) {
          ch = 'o'; hue = 255;
        }
      } else if (mode === 'life') {
        // Continents: a SEEDED organic field (value noise in texture
        // space), NOT the stage sine lattice. The old mask (pat > 0.2)
        // was the same regular sine lattice for every planet — a
        // hard-edged grid block that never changed with the seed, with
        // its whole interior forced to '#' (a wall of identical glyphs
        // at uniformly bumped brightness). The new field is blobby and
        // wobbly, unique per planet, with a feathered coast (smoothstep
        // over the threshold band + an RGB blend into the ocean color),
        // and internal variation from a fine noise octave (forest
        // clusters and inlets) — never a solid wall. The green is
        // shaded by the SAME brightness field as everything else
        // (shadeColor by b): darker toward the night side, brighter on
        // the lit side.
        const cont = continentField(tx, ty, seed);
        if (cont > 0.58) { // ~28% of the disc is land, like a real planet
          const green = clamp((cont - 0.58) / 0.14, 0, 1); // feathered coast
          // Fine detail at ~3-cell scale: inlets, bays, hue variation.
          const fine = valueNoise(tx * 8, ty * 8, seed + 977, 32);
          // Inlets: the fine field cuts bays and lakes into the coast,
          // so the edge is irregular and the interior is not uniform.
          landAmt = green * (0.55 + 0.45 * clamp((fine - 0.30) / 0.30, 0, 1));
          if (landAmt > 0.02) {
            // Forest clusters: dense '#' only in the deep interior,
            // never a wall across the whole patch.
            if (cont > 0.78 && fine > 0.62) ch = '#';
            // Vary the green within the patch (dark / mid / bright).
            landHue = fine > 0.62 ? 46 : (fine > 0.38 ? 34 : 22);
          } else landAmt = 0;
        }
      } else if (mode === 'civ') {
        // City lights are SPARKLES now (Nov 11, Devon's correction —
        // they DO rotate, so keep them; the problem was they always
        // looked the SAME: identical yellow '#' blocks every pass).
        // Each light lives in a DRIFTING TEXTURE cell (cx, cy — the
        // same coordinates as the embers and speckles), so it rotates
        // with the surface; its hash is seeded per planet, so every
        // planet's city pattern is different; and its twinkle phase
        // comes from its own hash, so the visible set changes as it
        // comes around — never the same identical pattern twice.
        // They are small ('.', '+', '*') in soft warm tones (222/230/
        // 229), much lighter and less dramatic than the old 226 blocks.
        if (b < 0.45 && sz > 0.45) {
          const ln = noise2(Math.floor(cx), Math.floor(cy), seed + 777);
          if (ln > 0.95) {
            // Twinkle: each light blinks on its own rhythm (its hash
            // picks the phase) — lit about 3 of every 4 beats.
            const tw = (Math.trunc(sec * 2.5) + Math.trunc(ln * 100)) % 4;
            if (tw !== 0) {
              if (ln > 0.985) { ch = '*'; hue = 229; }
              else if (ln > 0.97) { ch = '+'; hue = 230; }
              else { ch = '.'; hue = 222; }
              emissive = true;
            }
          }
        }
      } else if (mode === 'end') {
        if (b < 0.12) hue = 238;
        // Embers are surface features: sampled in the drifting texture
        // cells (quantized, so each texture cell is a stable ember that
        // rotates) — the old version was fixed in screen space and only
        // blinked in place. The blink phase comes from the ember's own
        // noise value, so each ember keeps its rhythm as it rotates.
        const en = noise2(Math.floor(cx), Math.floor(cy), seed);
        if (en > 0.9 && (Math.trunc(sec * 4) + Math.trunc(en * 100)) % 4 === 0) {
          hue = 160; ch = '*';
          emissive = true;
        }
      }
      if (st.banded) {
        // Belts darken the brightness (reel: body *= 1 - 0.35 * weather
        // * belts) — they show as darker regions of the SAME colors,
        // never as painted color blocks. weather here is the stage
        // fade: bands strengthen as the stage fades in. The belt pattern
        // lives in TEXTURE space (tx, ty): the old version sampled
        // screen coords (sx, ny) with a time wobble, so the dark bands
        // stood still while the planet rotated under them — the "dark
        // spot that doesn't rotate". Now the bands rotate with the
        // surface. (The latitude part, ty, is the same span as before:
        // ty = 2*ny, so ty*3.5 = ny*7.0.)
        const band = Math.sin(ty * 3.5 + 0.8 * Math.sin(tx * 3.0));
        const beltAmt = clamp((-band - 0.25) / 0.5, 0, 1);
        if (beltAmt > 0) {
          b = clamp(b * (1 - 0.35 * fade * beltAmt), 0.0, 1.0);
          ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(b * RAMP.length))];
        }
      }
      // Storm: a bright oval (reel: body += 0.55 * weather * storm
      // * lit). It runs on banded stages AND at End, where it fades
      // to half strength — the storm is dying with the world, not
      // switching off. Before Nov 11 it lived inside the banded
      // block, so it vanished at stage 7.
      if (st.banded || mode === 'end') {
        const stormFade = mode === 'end' ? 0.5 : 1.0;
        // It sits at a FIXED texture longitude for this planet
        // (stormX/stormY, seeded — hoisted above the loops), and the
        // longitude distance WRAPS with the texture period (4 radius
        // units = one full turn). The old version let the storm drift
        // off the disc after ~3s and never come back; now it crosses
        // the disc and returns every ~13s, at the same rate as the rest
        // of the surface. Brightness only — the storm brightens the
        // terrain's own colors, it does not recolor them.
        const dtx = pymod(tx - stormX + 2, 4) - 2; // wrapped longitude distance
        // Giant Storm mutation: the storm is TWICE as wide with a calm
        // dark eye at its center — a Jupiter-style Great Red Spot that
        // travels with the surface, instead of the small bright oval.
        const giant = activeMuts.has('giant-storm');
        const sSigX = giant ? 0.70 : 0.35, sSigY = giant ? 0.36 : 0.18;
        const stormAmt = Math.exp(-((dtx * dtx) / (2 * sSigX * sSigX) + ((ty - stormY) * (ty - stormY)) / (2 * sSigY * sSigY)));
        if (stormAmt > 0.15) {
          b = clamp(b + (giant ? 0.65 : 0.55) * fade * stormFade * stormAmt * Math.max(dif, 0), 0.0, 1.0);
          ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(b * RAMP.length))];
          if (giant) {
            const eyeAmt = Math.exp(-((dtx * dtx) / (2 * 0.22 * 0.22) + ((ty - stormY) * (ty - stormY)) / (2 * 0.11 * 0.11)));
            if (eyeAmt > 0.55) {
              b = clamp(b * 0.45, 0.0, 1.0);
              hue = 202;
              ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(b * RAMP.length))];
            }
          }
        }
      }
      // --- Mutation surface effects (piece 3) ---------------------------
      // Each effect is sampled in TEXTURE space (tx, ty / cx, cy), so it
      // rotates with the surface like everything else. The two sparkle
      // mutations are deliberately different: Crystal Crust is sparse
      // pastel crystals on a loose lattice, slow twinkle, everywhere on
      // the surface; Sparkling Surface is white-hot glints only where
      // the light hits, quick twinkle. One reads as embedded gems, the
      // other as sunlight on water or metal — never the same look.
      // (Devon's quality bar for Crystal Crust: pretty and intentional,
      // NOT a glitched-out planet — so the crystals sit on a regular
      // lattice with soft colors and a slow twinkle, never random
      // bright flashes or scrambled glyphs. The Glitch mutation, at the
      // bottom of render(), is the broken one.)
      if (mode !== 'dust') {
        const crystal = activeMuts.has('crystal-crust')
          && ['rock', 'molten', 'crust', 'ocean', 'life', 'civ', 'end'].includes(mode) && b > 0.15;
        const glint = activeMuts.has('sparkling-surface') && b > (mode === 'end' ? 0.25 : 0.5);
        if (glint) {
          const gh = noise2(Math.floor(cx), Math.floor(cy), seed + 888);
          if (gh > 0.965 && (Math.trunc(sec * 3 + gh * 10) % 3) !== 0) {
            ch = gh > 0.985 ? '*' : '+';
            hue = gh > 0.98 ? 255 : 51;
            glowB = clamp(b + 0.35, 0, 1);
          }
        } else if (crystal) {
          // Loose lattice: one sparkle per ~4x2 texture cells, hash
          // decides if the lattice point holds a crystal and which
          // pastel it is — regular enough to read as intentional,
          // irregular enough not to be a grid.
          const ch2 = noise2(Math.floor(cx / 4), Math.floor(cy / 2), seed + 555);
          if (ch2 > 0.86 && (Math.trunc(sec * 1 + ch2 * 10) % 8) !== 0) {
            const pastel = [201, 165, 129, 51, 153];
            ch = ch2 > 0.96 ? '*' : (ch2 > 0.91 ? '+' : '.');
            hue = pastel[Math.trunc(ch2 * 100) % pastel.length];
            glowB = clamp(b * 1.3 + 0.25, 0, 1);
          }
        }
        // Glowing Oceans: the night-side water glows cyan, in blotchy
        // patches that follow the ocean (never on land — Life checks
        // landAmt). The glow is bright enough to read on the dark side:
        // the wave glyph turns cyan and the cell glows at 0.45-0.75
        // brightness, so the night ocean visibly shines instead of
        // sitting black. (First version: glowB 0.30-0.55 with the
        // surface glyph — it read as a few faint dots.)
        if (activeMuts.has('glowing-oceans')
            && ['ocean', 'life', 'civ', 'end'].includes(mode)
            && b < 0.35 && landAmt < 0.05) {
          const og = valueNoise(tx * 3, ty * 3, seed + 222, 12);
          if (og > 0.55) {
            ch = '~';
            hue = 51;
            glowB = 0.45 + 0.30 * og;
          }
        }
      }
      // Final color. Land (Life stage) blends ocean -> green in RGB
      // space by landAmt, so the coast is a gradient over ~4 cells,
      // not a hard line. Everything else is the round-2 rule: the
      // terrain hue scaled in lightness by the brightness.
      let col;
      if (emissive) col = hue;
      else if (glowB >= 0) col = shadeColor(hue, glowB, 1.0);
      else if (crackB >= 0) col = shadeColor(hue, crackB, 1.0);
      else if (landAmt > 0) {
        const [or, og, ob] = ansi256ToRgb(shadeColor(hue, b, CONFIG.BODY_TINT));
        const [lr, lg, lb] = ansi256ToRgb(shadeColor(landHue, b, CONFIG.BODY_TINT));
        col = rgbToAnsi256(lerp(or, lr, landAmt), lerp(og, lg, landAmt), lerp(ob, lb, landAmt));
      } else col = shadeColor(hue, b, CONFIG.BODY_TINT);
      grid[y][x] = [ch, col];
    }
  }
}

// A MINI SHADED SPHERE (Nov 11): a tiny disc drawn with the same
// brightness-first shading as the planet — glyph picked from the
// brightness ramp, tint scaled in lightness by it, lit from the same
// fixed top-left light. Used by the moons so no moon is ever a bare
// letter. (The Civilization satellite used to share it, but Devon
// decided Nov 11 there should be no satellite at all — removed.)
// `farSide` + `r` are the moon occlusion (the planet's disc hides a
// moon on the far half of its orbit).
function drawMiniSphere(grid, mx, my, mr, tint, seed, farSide, r, minB) {
  const { CX, CY, RAMP } = CONFIG;
  const [lx, ly, lz] = LIGHT_NORM;
  const x0 = Math.max(0, Math.floor(mx - mr) - 1);
  const x1 = Math.min(CONFIG.W - 1, Math.ceil(mx + mr) + 1);
  const y0 = Math.max(0, Math.floor(my - mr / 2) - 1);
  const y1 = Math.min(CONFIG.H - 1, Math.ceil(my + mr / 2) + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sx = (x - mx) / mr;
      const sy = (y - my) / mr;
      const d2 = sx * sx + Math.pow(2 * sy, 2);
      if (d2 > 1.0) continue;
      if (farSide) {
        // On the far side the planet's disc hides the orbiter.
        const pdx = (x - CX) / r, pdy = (y - CY) / r;
        if (pdx * pdx + Math.pow(2 * pdy, 2) <= 1.0) continue;
      }
      const sz = Math.sqrt(1.0 - d2);
      let b = sx * lx + (2 * sy) * ly + sz * lz;
      if (b < 0) b = -b * 0.15; // night side: dim, not black
      // Craters: a couple of darker patches from a seeded hash of
      // the orbiter-local position, so each face differs a bit.
      if (noise2(Math.floor((x - mx) * 2), Math.floor((y - my) * 2), (seed || 0) + 31) > 0.82) b *= 0.6;
      // Dim floor: a tiny sphere reads as a whole sphere, not a
      // fragment — the lit side still carries the shading. Colored
      // moons get a HIGHER floor (0.5): a neon green / blood-red
      // moon has to read as green / red all over, not just on the
      // 2-3 lit cells — otherwise the mutation is invisible from the
      // dark side of its orbit. (First version used 0.35: the lit
      // cells read, the rest were dim grey-green — not enough.)
      if (minB === undefined) minB = 0.10;
      b = clamp(b, minB, 1.0);
      const ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(b * RAMP.length))];
      grid[y][x] = [ch, shadeColor(tint, b, 1.0)];
    }
  }
}

function drawMoons(grid, r, sec, planet, muts) {
  const { CX, CY } = CONFIG;
  // Moons orbit in the planet's equatorial plane — the same plane the
  // rings lie in, so the orbit ellipse rotates with the ring tilt.
  const tilt = ((planet.ringTilt || 0) * Math.PI) / 180;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const active = muts || new Set(planet.mutations || []);
  for (const m of planet.moons) {
    const ang = m.phase + sec * m.speed;
    // Orbit offset in cells, then rotated by the ring tilt.
    const ox = m.orbit * r * Math.cos(ang);
    const oy = 0.5 * m.orbit * r * Math.sin(ang);
    const mx = CX + ox * cosT - oy * sinT;
    const my = CY + ox * sinT + oy * cosT;
    // A moon mutation shows only when it's in the active set; a planet
    // WITHOUT the mutation shows the moon's plain base size and tint
    // (stored at generation) — so the mutation is a real difference.
    const bigOn = active.has('big-moon') && (m.mutantIds || []).includes('big-moon');
    const colorOn = (m.mutantIds || []).some(id =>
      (id === 'green-moon' || id === 'blood-moon') && active.has(id));
    const radius = bigOn ? m.radius : (m.baseRadius !== undefined ? m.baseRadius : m.radius);
    const tint = colorOn ? m.tint : (m.baseTint !== undefined ? m.baseTint : m.tint);
    // Far side = the moon is on the far half of its orbit (oy < 0,
    // the pre-rotation minor-axis offset — the rotation preserves
    // that component, so oy's sign is the far/near test at any tilt).
    // On the far side the planet's disc hides the moon.
    drawMiniSphere(grid, mx, my, radius, tint, planet.seed, oy < 0, r,
      colorOn ? 0.5 : 0.10);
  }
}

// AURORA CROWN — REMOVED (Devon, Nov 11, 4:20 PM): not a fan — it's
// just text, no glow, would look clunky no matter how it's done.
// The drawAurora function, its render() call and its export were
// deleted with it. Do not re-add an aurora mutation.

// COMET (piece 3): a bright visitor that sweeps diagonally across the
// frame every ~14s, visible for ~4s, head first with a fading tail
// behind it. It flies in front of everything — it is in the sky, not
// on the planet. Seeded direction, so every planet's comet comes from
// its own corner.
function drawComet(grid, sec, planet) {
  const seed = planet.seed || 0;
  const cycle = pymod(sec, 14);
  if (cycle >= 4) return; // between passes
  const { CX, CY } = CONFIG;
  const crng = mulberry32((seed + 606) >>> 0);
  const dirX = crng() < 0.5 ? 1 : -1;
  const dirY = crng() < 0.5 ? 1 : -1;
  const startX = CX - dirX * 75, startY = CY - dirY * 32;
  const vx = dirX * 30, vy = dirY * 13; // cells per second
  const headX = startX + vx * cycle, headY = startY + vy * cycle;
  // Tail: where the head was 0.12s, 0.24s, ... ago — fading with age.
  // Twelve steps, so the tail is a long visible streak, not a dot: the
  // first steps stay bright white, the far end dissolves into dim dots.
  for (let k = 12; k >= 0; k--) {
    const age = k * 0.12;
    if (age > cycle) continue;
    const tx = Math.round(headX - vx * age), ty = Math.round(headY - vy * age);
    if (tx < 0 || tx >= CONFIG.W || ty < 0 || ty >= CONFIG.H) continue;
    if (k === 0) grid[ty][tx] = ['@', 255];
    else grid[ty][tx] = [k <= 2 ? '+' : '.', k <= 2 ? 255 : (k <= 5 ? 250 : 244)];
  }
}

// METEOR SHOWER (piece 3): every ~9s, a 3s burst of streaks falling
// diagonally across the frame — eight meteors at once, each a bright
// head with a long fading tail, crossing in front of the planet. Seeded
// per planet (own fall direction, own start points); outside the burst
// window the sky is quiet. The streaks are long on purpose (7 cells):
// a 4-cell streak read as a white dot, not a falling star.
function drawMeteorShower(grid, sec, planet) {
  const seed = planet.seed || 0;
  const cycle = pymod(sec, 9);
  if (cycle >= 3.0) return; // between showers
  const { CX, CY } = CONFIG;
  const mrng = mulberry32((seed + 707) >>> 0);
  const dirX = mrng() < 0.5 ? 1 : -1;
  const vx = dirX * 20, vy = 9; // cells per second, falling down
  for (let i = 0; i < 8; i++) {
    const sx0 = CX + (mrng() - 0.5) * 120;
    const sy0 = CY - 36 + mrng() * 12;
    const phase = mrng() * 1.5; // staggered starts inside the burst
    const age = cycle - phase;
    if (age < 0 || age > 1.6) continue;
    const hx = sx0 + vx * age, hy = sy0 + vy * age;
    for (let k = 0; k < 7; k++) {
      const tx = Math.round(hx - vx * 0.09 * k), ty = Math.round(hy - vy * 0.09 * k);
      if (tx < 0 || tx >= CONFIG.W || ty < 0 || ty >= CONFIG.H) continue;
      if (k === 0) grid[ty][tx] = ['@', 255];
      else grid[ty][tx] = [k === 1 ? '+' : '.', k <= 2 ? 255 : (k <= 4 ? 250 : 244)];
    }
  }
}

// GLITCH (piece 3): the planet looks INTENTIONALLY broken — clearly
// different from Crystal Crust's pretty sparkles. Three breakages, all
// quantized to 0.4s beats so the corruption flickers instead of
// smearing: (a) horizontal slices of the frame shift sideways, (b) a
// few cells scramble into harsh glyphs in harsh colors, (c) one thin
// band dims out. It is the only mutation that touches the whole frame,
// including the stars — that is the point: the planet is glitched, not
// just its surface.
function applyGlitch(grid, sec, planet) {
  const seed = planet.seed || 0;
  const quantum = Math.floor(sec / 0.4);
  const grng = mulberry32(((seed + quantum * 7919) >>> 0));
  // (a) Slice shifts: 4 bands, 2-5 rows each, shifted +/-6 cells — big
  // enough to SEE in a still (the first version's +/-3 was lost on a
  // 57-cell disc). A shifted band reads as the picture tearing.
  for (let i = 0; i < 4; i++) {
    const y0 = Math.trunc(grng() * CONFIG.H);
    const h = 2 + Math.trunc(grng() * 4);
    const shift = Math.trunc(grng() * 13) - 6;
    if (shift === 0) continue;
    for (let y = y0; y < Math.min(CONFIG.H, y0 + h); y++) {
      const row = grid[y];
      const copy = row.map(c => [c[0], c[1]]);
      for (let x = 0; x < CONFIG.W; x++) {
        const src = x - shift;
        row[x] = (src >= 0 && src < CONFIG.W) ? copy[src] : [' ', null];
      }
    }
  }
  // (b) Scrambled cells: ~3% of the frame, harsh glyphs + harsh colors.
  const glyphs = '!<>[]#$%&@';
  const harsh = [201, 51, 196, 226];
  for (let y = 0; y < CONFIG.H; y++) {
    for (let x = 0; x < CONFIG.W; x++) {
      if (grid[y][x][1] === null) continue;
      if (noise2(x, y, quantum * 13 + (seed % 100)) > 0.97) {
        const h = noise2(x, y, quantum * 29 + (seed % 100));
        grid[y][x] = [
          glyphs[Math.trunc(h * glyphs.length) % glyphs.length],
          harsh[Math.trunc(h * harsh.length * 3) % harsh.length],
        ];
      }
    }
  }
  // (c) One dim scanline band, 3 rows, somewhere in the frame.
  const sy = Math.trunc(grng() * CONFIG.H);
  for (let y = sy; y < Math.min(CONFIG.H, sy + 3); y++) {
    for (let x = 0; x < CONFIG.W; x++) {
      const cell = grid[y][x];
      if (cell[1] === null) continue;
      cell[1] = shadeColor(cell[1], 0.25, 1.0);
    }
  }
}

// Render one frame of a planet at a lifecycle stage.
// stageIdx 0-7, t = seconds into the stage (morphs from the previous
// stage over 3s), sec = global running clock (drives flicker/drift).
// Returns a grid of [char, ansiColor] cells.
function render(planet, stageIdx, t, sec, zoom, stage0Style) {
  if (zoom === undefined) zoom = 1.0;
  if (stage0Style === undefined) stage0Style = 'exploded';
  const st = STAGES[stageIdx];
  const prev = STAGES[(stageIdx - 1 + STAGES.length) % STAGES.length];
  const m = clamp(t / 3.0); // smooth morph from the previous stage
  let radius = lerp(prev.radius, st.radius, m) * zoom * planet.size;
  let ring = lerp(prev.ring, st.ring, m);
  if (planet.ringType === 'none') ring = 0;
  if (st.mode === 'end') radius = lerp(radius, radius * 0.82, clamp(t / st.dur));
  const fade = 0.35 + 0.65 * m; // stages fade in, never pop
  // The mutations on this planet — all of them, from stage 0 (birth
  // rolls, Nov 11). Computed once, passed down to every draw step.
  const muts = activeMutations(planet);
  const grid = starGrid(sec, planet.atmosphere);
  if (ring > 0.05) drawRings(grid, radius, ring, sec, false, planet, muts);
  drawPlanet(grid, st, radius, sec, planet, fade, stage0Style, muts);
  if (ring > 0.05) drawRings(grid, radius, ring, sec, true, planet, muts);
  drawMoons(grid, radius, sec, planet, muts);
  // Sky mutations fly in front of everything (they are in the sky,
  // not on the planet). Glitch goes last — it corrupts the whole frame.
  if (muts.has('comet')) drawComet(grid, sec, planet);
  if (muts.has('meteor-shower')) drawMeteorShower(grid, sec, planet);
  if (muts.has('glitch')) applyGlitch(grid, sec, planet);
  return grid;
}

// ---------------------------------------------------------------------------
// LOW-RES (COZY) RENDERING — a small window must still read as a planet.
// The old small-window look scaled the full-res grid's cells down in
// CSS until the glyphs were unreadable pixels, and a point-sampled
// re-render just picks one random-ish cell per block — a jumble of
// unrelated colors with no form. The fix is AREA-AVERAGING: each output
// cell shows the AVERAGE tone of the whole footprint it covers, so the
// brightness gradient, the limb fade and the rings survive at any size.
// The glyph is picked from the average luminance (the round-2 rule);
// the color is the average RGB quantized back to ANSI. A block that
// averages to near-black stays blank, so the background stays empty
// and the disc's silhouette stays visible. (Nov 11, Devon's overnight
// list: cozy renders "a bunch of different color characters together".)
function downsampleGrid(grid, outW, outH) {
  const inH = grid.length, inW = grid[0].length;
  const { RAMP } = CONFIG;
  const out = [];
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * inH / outH);
    const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * inH / outH));
    const row = [];
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * inW / outW);
      const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * inW / outW));
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const col = grid[y][x][1];
          const [r, g, b] = col === null ? [0, 0, 0] : ansi256ToRgb(col);
          sr += r; sg += g; sb += b; n++;
        }
      }
      const ar = sr / n, ag = sg / n, ab = sb / n;
      const lum = (0.2126 * ar + 0.7152 * ag + 0.0722 * ab) / 255;
      if (lum < 0.02) { row.push([' ', null]); continue; }
      const ch = RAMP[Math.min(RAMP.length - 1, Math.trunc(lum * RAMP.length))];
      row.push([ch, rgbToAnsi256(ar, ag, ab)]);
    }
    out.push(row);
  }
  return out;
}

// Render one frame, then downsample it to a small grid (default half
// resolution, 68x38). Same planet, same stage, same moment — just fewer,
// bigger cells, so a narrow window shows the whole shaded sphere
// instead of cropping it or shrinking the glyphs to pixels. This is
// what the Space's Cozy mode and the VS Code sidebar's small-window
// render should use (the sidebar wiring itself is piece 4).
function renderCozy(planet, stageIdx, t, sec, zoom, outW, outH, stage0Style) {
  if (outW === undefined) outW = 68;
  if (outH === undefined) outH = 38;
  return downsampleGrid(render(planet, stageIdx, t, sec, zoom, stage0Style), outW, outH);
}

// ---------------------------------------------------------------------------
// COLLISION / FUSION ANIMATION — two planets smashing together (prestige).
// A real collision, not a gentle fade (Devon, Nov 11): dust clouds,
// swirling debris, the two worlds smashing together with material
// spraying out, then the mess coalescing into the offspring. Everything
// here is ASCII, on the same 136x76 grid as the planet renders, and a
// pure function of time — collisionFrame(a, b, offspring, t) returns
// the frame t seconds into the sequence, so the panel just calls it
// every tick and the animation is deterministic (same three seeds =
// same collision, forever). Timeline:
//   0.0-1.0  approach: the two discs spiral in around their common
//            center — an orbital inspiral (Devon, Nov 11): wide lazy
//            loops that tighten and speed up as the orbit decays,
//            until the glancing blow at t = 1.0 (slightly offset, so
//            the impact is messy, not dead-center)
//   1.0-1.5  impact: the discs squash into each other and SHATTER —
//            the pieces keep the inspiral's spin and spiral outward
//            as they fly apart (Devon, Nov 11: the planets stopped
//            dead at the impact, then a spray — they have to break
//            apart in pieces, spiraling, not freeze and then spray).
//            A white-hot flash blooms at the contact point, a
//            shockwave starts out
//   1.5-3.0  explosion: the shards spiral outward and crumble cell by
//            cell, debris sprays out in all directions, dust clouds
//            billow, the shockwave runs
//   3.0-4.2  swirl: the debris orbits the center (faster when closer,
//            Kepler-ish), the dust contracts
//   4.2-5.2  coalescence: the mess spirals in and the offspring
//            condenses out of it, with a hot accretion rim
//   5.2+     the offspring, whole, with a few embers still drifting
// The parents render WITHOUT rings — the rings are the first thing a
// real collision shreds. Moons stay (they become debris with the rest).
// ---------------------------------------------------------------------------
const COLLISION_TIMELINE = { approach: 1.0, impact: 1.5, explosion: 3.0, swirl: 4.2, coalesce: 5.2 };
const COLLISION_END = 5.2;
const COLLISION_DISC_W = 84, COLLISION_DISC_H = 46;
// Approach inspiral geometry: A starts at orbit-space offset (-46, -10)
// from the center (68, 38) — the same starting spots as the old slide —
// and B opposite. Orbit space is (dx, 2*dy), so a circle in orbit space
// is a circle on screen (cells are 10x18). The orbit decays from R0 to
// R1 (the glancing offset at contact) while the angle sweeps SWEEP
// radians — the short way to the contact angle, plus one full orbit
// (1.22 turns total). At t = 1.0 the discs land exactly where the old
// slide put them (A above the center, B below), so the impact and
// everything after it are untouched.
const COLLISION_R0 = Math.hypot(46, 10);
const COLLISION_R1 = 10;
const COLLISION_TH0 = Math.atan2(-10, -46);
const COLLISION_SWEEP = (-Math.PI / 2 - COLLISION_TH0) + Math.PI * 2;

function collisionPhase(t) {
  if (t < COLLISION_TIMELINE.approach) return 'approach';
  if (t < COLLISION_TIMELINE.impact) return 'impact';
  if (t < COLLISION_TIMELINE.explosion) return 'explosion';
  if (t < COLLISION_TIMELINE.swirl) return 'swirl';
  if (t < COLLISION_TIMELINE.coalesce) return 'coalesce';
  return 'done';
}

// The collision discs: the planet drawn (disc + moons, no rings, no
// starfield) and downsampled to a small grid, so the stage can slide
// them around and smash them together. Rendered once per planet and
// cached — the frame function runs every tick, and re-rendering three
// full planets per frame would be wasteful. The cache is keyed on
// everything that changes the picture; same inputs, same grid.
const _collisionDiscCache = new Map();
function collisionDisc(planet, stageIdx) {
  const key = (planet.seed || 0) + '|' + stageIdx + '|' + (planet.mutations || []).join('+')
    + '|' + (planet.size || 1) + '|' + planet.terrain;
  let g = _collisionDiscCache.get(key);
  if (!g) {
    const st = STAGES[stageIdx];
    const radius = st.radius * (planet.size || 1);
    const muts = activeMutations(planet);
    const full = makeGrid();
    drawPlanet(full, st, radius, 3, planet, 1.0, 'exploded', muts);
    drawMoons(full, radius, 3, planet, muts);
    g = downsampleGrid(full, COLLISION_DISC_W, COLLISION_DISC_H);
    if (_collisionDiscCache.size > 12) _collisionDiscCache.delete(_collisionDiscCache.keys().next().value);
    _collisionDiscCache.set(key, g);
  }
  return g;
}

// The debris: 260 particles, all derived from one seeded stream, so
// the spray is the same every replay. Each particle has a birth angle
// and radius, a radial spray speed, a tangential curve, and an orbit
// direction. Its position is a pure function of t (see
// collisionParticleAt) — no per-frame state, so the panel can scrub
// the timeline freely.
function collisionParticles(seed) {
  const rng = mulberry32(seed >>> 0);
  const HOT = [231, 229, 226, 214, 202, 196];
  const parts = [];
  for (let i = 0; i < 260; i++) {
    parts.push({
      idx: i,
      angle: rng() * Math.PI * 2,
      r0: 6 + rng() * 24,
      speed: 10 + rng() * 30,
      curve: (rng() - 0.5) * 0.7,
      spin: rng() < 0.5 ? -1 : 1,
      hot: HOT[Math.trunc(rng() * HOT.length)],
      big: rng() < 0.18,
    });
  }
  return parts;
}

// Where one particle is at time t (stage coords, y already squashed
// for the cell ellipse), and what it looks like then — or null when it
// is still inside its planet or has been absorbed into the offspring.
// The spray is radial first, then the debris falls into orbit (faster
// when closer), then it spirals in and vanishes into the newborn disc.
// Particles cool as they go: white-hot at the impact, dim embers by
// the end.
function collisionParticleAt(p, t) {
  // Radius / angle at the end of the explosion (t = 3.0) — every later
  // phase continues from here, so the path is continuous.
  const r3 = p.r0 + p.speed * 0.825;
  const th3 = p.angle + p.curve * 1.5;
  const omega = p.spin * clamp(2.4 * Math.pow(14 / Math.max(8, r3), 1.5), 0.4, 3.0);
  let r, th, heat;
  if (t < 1.0) return null;
  if (t < 1.5) {
    const u = (t - 1.0) / 0.5;
    r = p.r0 * 0.35 * Math.pow(u, 0.7);
    th = p.angle + p.curve * u * 0.5;
    heat = 1.0;
  } else if (t < 3.0) {
    const u = (t - 1.5) / 1.5;
    r = p.r0 * (0.35 + 0.65 * u) + p.speed * (t - 1.5) * 0.55;
    th = p.angle + p.curve * (0.5 + u);
    heat = 1.0 - u * 0.4;
  } else if (t < 4.2) {
    const u = (t - 3.0) / 1.2;
    r = r3 * (1 - 0.12 * u);
    th = th3 + omega * (t - 3.0);
    heat = 0.55;
  } else if (t < 5.2) {
    const u = (t - 4.2) / 1.0;
    const r42 = r3 * 0.88;
    const th42 = th3 + omega * 1.2;
    r = lerp(r42, 20, u * u);
    th = th42 + omega * (t - 4.2) * 1.5;
    if (r <= 21) return null; // absorbed into the offspring
    heat = 0.3;
  } else {
    // Finale: only a few slow embers linger.
    if (p.idx % 4 !== 0) return null;
    r = Math.max(24, r3 * 0.7);
    th = th3 + omega * 2.4;
    heat = 0.2;
  }
  const x = 68 + r * Math.cos(th);
  const y = 38 + r * Math.sin(th) * 0.5;
  let ch, col;
  if (heat > 0.8) { ch = p.big ? '#' : (p.speed > 28 ? '@' : '*'); col = p.hot; }
  else if (heat > 0.45) { ch = p.big ? '#' : '*'; col = 214; }
  else if (heat > 0.25) { ch = '+'; col = 208; }
  else { ch = '.'; col = 242; }
  return { x, y, ch, col };
}

// Dust clouds: seven billowing clouds that blow out from the impact,
// drift around the center, then get pulled back in as the offspring
// gathers itself. Drawn as sparse dim glyphs (noise-gated, so they
// read as soft clouds, not solid blobs), behind everything else.
function drawCollisionDust(grid, seed, t) {
  if (t < 1.0) return;
  const rng = mulberry32((seed ^ 0xD057) >>> 0);
  for (let i = 0; i < 7; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = 8 + rng() * 18;
    const maxR = 12 + rng() * 14;
    const cseed = 1000 + i * 77 + Math.trunc(rng() * 500);
    const color = [240, 242, 244, 216, 180, 137][Math.trunc(rng() * 6)];
    const spin = rng() < 0.5 ? -1 : 1;
    const ang = angle + spin * 0.22 * Math.max(0, t - 1.0);
    let ccx = 68 + dist * Math.cos(ang);
    let ccy = 38 + dist * Math.sin(ang) * 0.5;
    let cr;
    if (t < 3.0) cr = lerp(4, maxR, (t - 1.0) / 2.0);
    else if (t < 4.2) cr = maxR;
    else {
      const u = (t - 4.2) / 1.0;
      cr = lerp(maxR, 5, u);
      ccx = lerp(ccx, 68, u);
      ccy = lerp(ccy, 38, u);
    }
    if (t >= 5.2) cr = 5;
    const x0 = Math.max(0, Math.floor(ccx - cr)), x1 = Math.min(CONFIG.W - 1, Math.ceil(ccx + cr));
    const y0 = Math.max(0, Math.floor(ccy - cr / 2)), y1 = Math.min(CONFIG.H - 1, Math.ceil(ccy + cr / 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - ccx, dy = (y - ccy) * 2;
        if (Math.sqrt(dx * dx + dy * dy) > cr) continue;
        if (grid[y][x][1] !== null) continue; // dust stays behind everything
        const n = noise2(x * 0.45, y * 0.45, cseed);
        if (n < 0.60) continue;
        grid[y][x] = [n > 0.82 ? ':' : '.', color];
      }
    }
  }
}

// The shockwave: a sparse expanding ellipse, brightest just after the
// impact, gone by the time the spray peaks.
function drawCollisionShockwave(grid, t) {
  const u = (t - 1.1) / 1.0;
  const R = 10 + 52 * u;
  const fade = 1 - u;
  for (let a = 0; a < Math.PI * 2; a += 0.02) {
    const x = Math.round(68 + R * Math.cos(a));
    const y = Math.round(38 + R * Math.sin(a) * 0.5);
    if (x < 0 || x >= CONFIG.W || y < 0 || y >= CONFIG.H) continue;
    if (noise2(x, y, 7) < 0.55 + (1 - fade) * 0.3) continue;
    grid[y][x] = [noise2(x, y, 8) > 0.7 ? '*' : '.', 214];
  }
}

// SHARDS — at the moment of contact the discs shatter into chunks
// (Devon, Nov 11: the planets stopped dead at the impact, then a
// particle spray — they have to break apart in pieces, spiraling as
// they fly apart). Each disc is cut into 16 chunks (8 angular sectors
// x inner/outer band); every chunk is a rigid piece of the disc that
// keeps the approach inspiral's rotational motion — it spirals
// outward around the collision center (radius grows, angle advances
// in the same direction as the inspiral) while it crumbles cell by
// cell, so the explosion reads as the planets breaking apart, not as
// the discs stopping and a spray starting. All deterministic: chunk
// params come from the disc seed + chunk id, positions are a pure
// function of t.
const COLLISION_SHARD_SECTORS = 8;

function collisionShardId(sx, sy, Wd, H) {
  const dx = sx - Wd / 2, dy = (sy - H / 2) * 2;
  const ang = Math.atan2(dy, dx);
  const sector = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * COLLISION_SHARD_SECTORS) % COLLISION_SHARD_SECTORS;
  const band = Math.hypot(dx, dy) > 24 ? 1 : 0;
  return band * COLLISION_SHARD_SECTORS + sector;
}

// Deterministic per-chunk motion params from the disc seed + chunk id.
function collisionShardParams(discSeed, chunkId) {
  const rng = mulberry32(((discSeed >>> 0) ^ Math.imul(chunkId + 1, 2654435761)) >>> 0);
  return {
    omegaBase: 0.5 + rng() * 0.6,   // rad/s scale (Kepler-scaled by radius)
    v: 5 + rng() * 12,              // orbit-space units/s outward
    breakT: 1.5 + rng() * 0.7,      // when the chunk starts crumbling
    dissolveDur: 0.4 + rng() * 0.3, // how long the crumble takes
  };
}

// Where a shard at orbit-space polar (rho0, th0) around the collision
// center is dt seconds after contact. Pure motion law — exported for
// tests. Angle advances in the same direction as the approach inspiral
// (positive sweep), radius grows: the pieces spiral outward as they
// fly apart.
function collisionShardAt(rho0, th0, omega, v, dt) {
  const rho = rho0 + v * dt;
  const th = th0 + omega * dt;
  return { x: 68 + rho * Math.cos(th), y: (76 + rho * Math.sin(th)) / 2, rho, th };
}

// One parent disc, composited onto the stage at (cx, cy) — squashed
// horizontally during the impact. Before contact the whole disc is
// drawn as one; from contact on it is shards: each chunk's cells are
// collected, the chunk's centroid is worked out in orbit space, and
// the whole chunk is translated along its outward spiral, crumbling
// cell by cell after its break time. Only non-blank cells land, so
// the disc's transparent background never paints over the stage.
function drawCollisionDisc(grid, disc, cx, cy, squash, t, discSeed) {
  const H = disc.length, Wd = disc[0].length;
  if (t < 1.0) {
    for (let sy = 0; sy < H; sy++) {
      for (let sx = 0; sx < Wd; sx++) {
        const cell = disc[sy][sx];
        if (cell[1] === null) continue;
        const dx = Math.round(cx + (sx - Wd / 2) * squash);
        const dy = Math.round(cy + (sy - H / 2));
        if (dx < 0 || dx >= CONFIG.W || dy < 0 || dy >= CONFIG.H) continue;
        grid[dy][dx] = cell;
      }
    }
    return;
  }
  const dt = t - 1.0;
  const chunks = new Map(); // id -> {cells, sumX, sumY, n}
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < Wd; sx++) {
      const cell = disc[sy][sx];
      if (cell[1] === null) continue;
      const id = collisionShardId(sx, sy, Wd, H);
      let c = chunks.get(id);
      if (!c) { c = { cells: [], sumX: 0, sumY: 0, n: 0 }; chunks.set(id, c); }
      c.cells.push([sx, sy, cell]);
      c.sumX += (sx - Wd / 2) * squash;
      c.sumY += sy - H / 2;
      c.n++;
    }
  }
  for (const [id, c] of chunks) {
    const params = collisionShardParams(discSeed, id);
    // Chunk centroid at contact, in orbit space relative to the
    // collision center (68, 76).
    const ccx = c.sumX / c.n, ccy = c.sumY / c.n;
    const X0 = cx + ccx - 68;
    const Y0 = 2 * (cy + ccy) - 76;
    const rho0 = Math.hypot(X0, Y0);
    const th0 = Math.atan2(Y0, X0);
    const omega = params.omegaBase * Math.pow(14 / Math.max(8, rho0), 0.5);
    const at = collisionShardAt(rho0, th0, omega, params.v, dt);
    // Displacement of the chunk's centroid since contact (stage coords).
    const ddx = at.x - (cx + ccx);
    const ddy = at.y - (cy + ccy);
    let gone = 0;
    if (t >= params.breakT) gone = clamp((t - params.breakT) / params.dissolveDur, 0, 1);
    for (const [sx, sy, cell] of c.cells) {
      if (gone > 0 && hash2(sx, sy, discSeed) < gone) continue;
      const dx = Math.round(cx + (sx - Wd / 2) * squash + ddx);
      const dy = Math.round(cy + (sy - H / 2) + ddy);
      if (dx < 0 || dx >= CONFIG.W || dy < 0 || dy >= CONFIG.H) continue;
      grid[dy][dx] = cell;
    }
  }
}

// The impact flash: a white-hot bloom at the contact point, peaking
// just after the discs meet and gone by the time the spray is out.
// (The white here is a transient explosion — the old stamped white
// sun-core rule doesn't apply to a momentary flash.)
function drawCollisionFlash(grid, t) {
  const u = (t - 1.0) / 0.7;
  const R = 15 * Math.sin(Math.PI * u);
  if (R <= 0.5) return;
  for (let y = Math.max(0, Math.floor(38 - R / 2)); y <= Math.min(CONFIG.H - 1, Math.ceil(38 + R / 2)); y++) {
    for (let x = Math.max(0, Math.floor(68 - R)); x <= Math.min(CONFIG.W - 1, Math.ceil(68 + R)); x++) {
      const dx = x - 68, dy = (y - 38) * 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > R) continue;
      const n = noise2(x, y, 99);
      if (n < 0.3) continue;
      const f = d / R;
      grid[y][x] = [
        n > 0.85 ? '@' : (n > 0.6 ? '#' : '*'),
        f < 0.35 ? 231 : (f < 0.65 ? 229 : (f < 0.85 ? 226 : 202)),
      ];
    }
  }
}

// The offspring condenses: its cells appear inside a growing radius,
// with a hot accretion rim at the leading edge.
function drawCollisionOffspring(grid, disc, R) {
  const H = disc.length, Wd = disc[0].length;
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < Wd; sx++) {
      const cell = disc[sy][sx];
      if (cell[1] === null) continue;
      const dx = Math.round(68 + (sx - Wd / 2));
      const dy = Math.round(38 + (sy - H / 2));
      if (dx < 0 || dx >= CONFIG.W || dy < 0 || dy >= CONFIG.H) continue;
      const ddx = dx - 68, ddy = (dy - 38) * 2;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d > R) continue;
      grid[dy][dx] = (d > R - 3) ? [cell[0], 226] : cell;
    }
  }
}

// One frame of the fusion collision. Pure function of (planets, t) —
// the panel calls it every tick with the seconds since the fusion
// started. `sec` only drives the starfield twinkle.
function collisionFrame(planetA, planetB, offspring, t, sec) {
  if (sec === undefined) sec = 0;
  t = Math.max(0, t);
  const grid = makeGrid();
  for (const [sx, sy, , ch] of STARS) {
    if (sx < CONFIG.W && sy < CONFIG.H) {
      grid[sy][sx] = [ch, (hash2(sx, sy, 3) + sec * 0.1) % 1 > 0.6 ? 250 : 244];
    }
  }
  const seed = ((planetA.seed || 0) ^ (planetB.seed || 0) ^ (offspring.seed || 0)) >>> 0;
  drawCollisionDust(grid, seed, t);
  if (t >= 1.1 && t < 2.1) drawCollisionShockwave(grid, t);
  const discA = collisionDisc(planetA, 6);
  const discB = collisionDisc(planetB, 6);
  const squash = (t >= 1.0 && t < 1.5) ? 1 - 0.45 * Math.sin(Math.PI * (t - 1.0) / 0.5) : 1;
  // Where the two discs sit. During the approach they orbit their
  // common center on a decaying orbit — slow wide loops first, then a
  // fast plunge as the orbit tightens (radius falls as 1 - p^2, angle
  // advances as p^1.5, so both the closing and the circling accelerate
  // into the blow). From t = 1.0 on, both discs sit at the contact
  // spots — but they don't stay there: drawCollisionDisc shatters
  // them into shards that spiral outward from the contact, so the
  // rotational motion carries straight through the impact.
  let ax, ay, bx, by;
  if (t < 1.0) {
    const p = clamp(t / 1.0, 0, 1);
    const r = COLLISION_R1 + (COLLISION_R0 - COLLISION_R1) * (1 - p * p);
    const th = COLLISION_TH0 + COLLISION_SWEEP * Math.pow(p, 1.5);
    ax = 68 + r * Math.cos(th);
    ay = 38 + r * Math.sin(th) * 0.5;
    bx = 68 - r * Math.cos(th);
    by = 38 - r * Math.sin(th) * 0.5;
  } else {
    ax = 68; ay = 33; bx = 68; by = 43;
  }
  if (t < 3.0) {
    drawCollisionDisc(grid, discA, ax, ay, squash, t, ((planetA.seed || 0) ^ 0xA11CE) >>> 0);
    drawCollisionDisc(grid, discB, bx, by, squash, t, ((planetB.seed || 0) ^ 0xB11CE) >>> 0);
  }
  if (t >= 1.0 && t < 1.7) drawCollisionFlash(grid, t);
  const parts = collisionParticles(seed);
  for (const pt of parts) {
    const at = collisionParticleAt(pt, t);
    if (!at) continue;
    const x = Math.round(at.x), y = Math.round(at.y);
    if (x < 0 || x >= CONFIG.W || y < 0 || y >= CONFIG.H) continue;
    grid[y][x] = [at.ch, at.col];
  }
  if (t >= 4.2) {
    const discO = collisionDisc(offspring, 0);
    drawCollisionOffspring(grid, discO, lerp(0, 26, clamp((t - 4.2) / 1.0)));
  }
  return grid;
}

// ---------------------------------------------------------------------------
// ANSI-256 -> hex (for HTML rendering), ported from capture_frames.py.
// ---------------------------------------------------------------------------
const STD16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
  [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function ansi256ToRgb(code) {
  if (code === null || code === undefined) return [0, 0, 0];
  if (code < 16) return STD16[code].slice();
  if (code < 232) {
    const n = code - 16;
    const f = v => (v === 0 ? 0 : 55 + 40 * v);
    return [f(Math.floor(n / 36) % 6), f(Math.floor(n / 6) % 6), f(n % 6)];
  }
  const v = 8 + 10 * (code - 232);
  return [v, v, v];
}
function ansi256ToHex(code) {
  const [r, g, b] = ansi256ToRgb(code);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Nearest ANSI-256 code to an RGB triplet: nearest 6x6x6 cube color vs
// nearest grey-ramp color, whichever is closer in RGB distance. The grid
// stays ANSI codes (gridToHtml, make-samples.py and the tests all expect
// them) — brightness-scaled colors are quantized back into the palette.
function rgbToAnsi256(r, g, b) {
  r = clamp(Math.round(r), 0, 255); g = clamp(Math.round(g), 0, 255); b = clamp(Math.round(b), 0, 255);
  const lv = [0, 95, 135, 175, 215, 255];
  const q = v => (v < 48 ? 0 : (v < 115 ? 1 : Math.round((v - 55) / 40)));
  const cr = q(r), cg = q(g), cb = q(b);
  const cube = 16 + 36 * cr + 6 * cg + cb;
  const dCube = (r - lv[cr]) ** 2 + (g - lv[cg]) ** 2 + (b - lv[cb]) ** 2;
  const grey = Math.round((r + g + b) / 3);
  const gi = grey < 8 ? 0 : (grey > 238 ? 23 : Math.round((grey - 8) / 10));
  const gv = 8 + 10 * gi;
  const dGrey = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return dCube <= dGrey ? cube : 232 + gi;
}

// Blend two ANSI-256 hues into one (RGB lerp, quantized back to the
// palette). Used where colors must FLOW into each other instead of
// sitting as separate solid blocks — the stage-0 ring's mutation
// colors (Nov 11: Devon said the ring was too uniform, one solid
// color then another; the hues have to blend along the ring).
function blendHue(codeA, codeB, t) {
  const [ar, ag, ab] = ansi256ToRgb(codeA);
  const [br, bg, bb] = ansi256ToRgb(codeB);
  return rgbToAnsi256(
    lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t));
}

// Brightness-first color (round 2): the terrain hue is a TINT, not a
// solid block. final = grey(lum) blended with (hue * lum). Dark areas
// stay dark whatever the terrain; bright areas show the hue. This is
// what makes the sphere look 3D — the characters carry the shading,
// the color just tints it (the reel's rule: glyphs ARE the shading).
function shadeColor(hueCode, lum, tint) {
  const [hr, hg, hb] = ansi256ToRgb(hueCode);
  const grey = 235 * lum;
  return rgbToAnsi256(
    grey * (1 - tint) + hr * lum * tint,
    grey * (1 - tint) + hg * lum * tint,
    grey * (1 - tint) + hb * lum * tint,
  );
}

// Grid -> HTML with FIXED-SIZE cells. This is the rendering rule for the
// whole project — read it before rendering a grid anywhere else:
//
// NEVER let font metrics decide cell geometry. A browser may substitute a
// different monospace font, and mobile browsers inflate small text (iOS
// Safari text autosizing) while line-height stays fixed — the planet comes
// out squashed wide and flat (Nov 10: Devon saw exactly this on his phone).
// So every color run is an inline-block span with an EXPLICIT width
// (chars x cellW), and the CSS fixes height/line-height to cellH. The font
// only draws glyphs inside those boxes; it never decides where a cell is.
// Blank runs are empty fixed-width boxes — no text at all, so no font can
// stretch them. Same 10:18 cell ratio as the PIL renderer and the v5 clip.
//
// cellW/cellH are CSS px (default CONFIG.CELL_W/CELL_H = 10x18). The preview
// page passes smaller values on narrow screens so the grid fits — the RATIO
// is what matters, and it must stay 10:18.
// (Used by the preview page and later by the webviews.)
function gridToHtml(grid, cellW, cellH) {
  if (cellW === undefined) cellW = CONFIG.CELL_W;
  if (cellH === undefined) cellH = CONFIG.CELL_H;
  let html = '';
  for (const row of grid) {
    let cur = null, buf = '';
    const flush = () => {
      const n = buf.length;
      if (!n) return;
      const w = (n * cellW).toFixed(1).replace(/\.0$/, '');
      if (cur === null) {
        html += `<span class="pp-run" style="width:${w}px"></span>`;
      } else {
        const esc = buf.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += `<span class="pp-run" style="width:${w}px;color:${ansi256ToHex(cur)}">${esc}</span>`;
      }
      buf = '';
    };
    for (const [ch, col] of row) {
      if (col !== cur) { flush(); cur = col; }
      buf += ch;
    }
    flush();
    html += '\n';
  }
  return html;
}

// Plain-text grid (chars only) — handy for tests and terminal dumps.
function gridToText(grid) {
  return grid.map(row => row.map(([ch]) => ch).join('')).join('\n');
}

// ---------------------------------------------------------------------------
// Exports: Node (require) and browser/webview (window.Protoplanet).
// ---------------------------------------------------------------------------
const API = {
  CONFIG, STAGES, STARS, STAGE0_STYLES,
  mulberry32, generatePlanet, generatePlanetName, formatCatalogName, parseCatalogName, buildFragments, buildSmoke, buildSparkles, buildCoreMarkers, coreMarkerAt, smokeCellAt,
  mutationDef, activeMutations, hasMutation, mutationLabel,
  collisionFrame, collisionPhase, collisionShardAt, COLLISION_TIMELINE, COLLISION_END,
  drawComet, drawMeteorShower, applyGlitch,
  makeGrid, render, renderCozy, downsampleGrid, drawPlanet, drawRings, drawMoons, drawMiniSphere, starGrid,
  ansi256ToHex, ansi256ToRgb, shadeColor, blendHue, gridToHtml, gridToText,
  noise2, continentField, valueNoise, hash2, clamp, lerp,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.Protoplanet = API;
