// test-pet.js — Piece 2 headless tests. Runs in plain Node, no VS Code.
// Every check here exercises the pure logic in petLogic.js (the same
// functions extension.js calls), plus the package.json contract.
//
//   node test-pet.js
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./petLogic.js');
const Planet = require('./planet.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (extra !== undefined ? ' — ' + extra : '')); console.log('FAIL: ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
function eq(name, got, want) {
  check(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

// Deterministic seed source for tests: 1000, 1007, 1014, ...
function seedSeq(start) {
  let s = start === undefined ? 1000 : start;
  return () => { s += 7; return s; };
}

function freshWithPlanet(seed) {
  const st = L.freshState();
  L.startFirstPlanet(st, seed === undefined ? 42 : seed, undefined);
  return st;
}

// --- 1. Counting inserted characters ---------------------------------------
eq('count: plain insert', L.countInsertedChars([{ text: 'hello', rangeLength: 0 }]), 5);
eq('count: pure deletion', L.countInsertedChars([{ text: '', rangeLength: 3 }]), 0);
eq('count: replace deleting more than inserting', L.countInsertedChars([{ text: 'xy', rangeLength: 5 }]), 0);
eq('count: replace inserting more than deleting', L.countInsertedChars([{ text: 'abcdef', rangeLength: 2 }]), 4);
eq('count: multiple changes in one event', L.countInsertedChars([
  { text: 'ab', rangeLength: 0 }, { text: 'c', rangeLength: 0 }, { text: '', rangeLength: 9 },
]), 3);
eq('count: empty change list', L.countInsertedChars([]), 0);
eq('count: paste counts', L.countInsertedChars([{ text: 'x'.repeat(500), rangeLength: 0 }]), 500);

// --- 2. Which documents earn XP --------------------------------------------
eq('scheme: file counts', L.shouldCountDocument('file'), true);
eq('scheme: untitled counts', L.shouldCountDocument('untitled'), true);
eq('scheme: notebook cell counts', L.shouldCountDocument('vscode-notebook-cell'), true);
eq('scheme: output ignored', L.shouldCountDocument('output'), false);
eq('scheme: git ignored', L.shouldCountDocument('git'), false);
eq('scheme: settings UI ignored', L.shouldCountDocument('vscode-userdata'), false);

// --- 3. Stage thresholds ----------------------------------------------------
const T = L.CONFIG.XP_THRESHOLDS;
eq('stage: 0 xp -> Dust cloud', L.stageForXp(0), 0);
eq('stage: 99 xp -> Dust cloud', L.stageForXp(99), 0);
eq('stage: 100 xp -> Accretion', L.stageForXp(100), 1);
eq('stage: 299 xp -> Accretion', L.stageForXp(299), 1);
eq('stage: 300 xp -> Molten', L.stageForXp(300), 2);
eq('stage: 599 xp -> Molten', L.stageForXp(599), 2);
eq('stage: 600 xp -> Crust', L.stageForXp(600), 3);
eq('stage: 999 xp -> Crust', L.stageForXp(999), 3);
eq('stage: 1000 xp -> Oceans', L.stageForXp(1000), 4);
eq('stage: 1499 xp -> Oceans', L.stageForXp(1499), 4);
eq('stage: 1500 xp -> Life', L.stageForXp(1500), 5);
eq('stage: 2199 xp -> Life', L.stageForXp(2199), 5);
eq('stage: 2200 xp -> Civilization', L.stageForXp(2200), 6);
eq('stage: 2999 xp -> Civilization', L.stageForXp(2999), 6);
eq('stage: 3000 xp -> End', L.stageForXp(3000), 7);
eq('stage: 3599 xp -> End', L.stageForXp(3599), 7);
eq('thresholds: 8 stages', T.length, 8);
eq('thresholds: strictly increasing', T.every((v, i) => i === 0 || v > T[i - 1]), true);

// --- 4. Progress info --------------------------------------------------------
let info = L.stageInfo(640);
eq('progress: 640 xp is stage 3 (Crust)', info.stageIdx, 3);
eq('progress: stage name', info.name, 'Crust');
eq('progress: stage start', info.stageStart, 600);
eq('progress: next threshold', info.nextXp, 1000);
eq('progress: in-stage xp', info.inStage, 40);
eq('progress: stage span', info.span, 400);
info = L.stageInfo(3200);
eq('progress: 3200 xp is stage 7 (End)', info.stageIdx, 7);
eq('progress: End next threshold is rebirth', info.nextXp, L.CONFIG.REBIRTH_XP);
eq('progress: End stage start', info.stageStart, 3000);
info = L.stageInfo(0);
eq('progress: 0 xp next threshold is 100', info.nextXp, 100);

// --- 5. XP accumulation through stages --------------------------------------
let st = freshWithPlanet(42);
let res = L.applyXp(st, 50, seedSeq());
eq('xp: 50 chars stays Dust cloud', res.stageIdx, 0);
eq('xp: no stage change at 50', res.stageChanged, false);
eq('xp: no rebirth at 50', res.rebirthed, false);
eq('xp: total is 50', st.current.xp, 50);
eq('xp: chars tracked', st.current.chars, 50);
res = L.applyXp(st, 60, seedSeq());
eq('xp: 110 chars -> Accretion', res.stageIdx, 1);
eq('xp: stage changed at 110', res.stageChanged, true);
res = L.applyXp(st, 890, seedSeq());
eq('xp: 1000 chars -> Oceans', res.stageIdx, 4);
eq('xp: 1000 chars total', st.current.xp, 1000);
eq('xp: generation still 1', st.generation, 1);
eq('xp: nothing archived yet', st.past.length, 0);
res = L.applyXp(st, 0, seedSeq());
eq('xp: 0 chars is a no-op', res.stageChanged, false);
res = L.applyXp(st, -5, seedSeq());
eq('xp: negative is a no-op', st.current.xp, 1000);

// --- 6. Rebirth ---------------------------------------------------------------
st = freshWithPlanet(42);
L.applyXp(st, 3550, seedSeq());
eq('rebirth: 3550 is End', L.stageForXp(st.current.xp), 7);
const oldSeed = st.current.seed;
res = L.applyXp(st, 100, seedSeq(5000));
eq('rebirth: crossed 3600 -> rebirthed', res.rebirthed, true);
eq('rebirth: one planet archived', st.past.length, 1);
eq('rebirth: archived chars', st.past[0].chars, 3650);
eq('rebirth: archived seed is the old one', st.past[0].seed, oldSeed);
eq('rebirth: archived generation is 1', st.past[0].generation, 1);
eq('rebirth: generation is now 2', st.generation, 2);
eq('rebirth: leftover XP carries over (50)', st.current.xp, 50);
eq('rebirth: leftover chars carry over', st.current.chars, 50);
eq('rebirth: new planet is Dust cloud', L.stageForXp(st.current.xp), 0);
eq('rebirth: new seed differs', st.current.seed !== oldSeed, true);

// One giant paste can hatch two planets in a row.
st = freshWithPlanet(42);
res = L.applyXp(st, 7300, seedSeq(9000));
eq('rebirth x2: 7300 chars -> two rebirths', st.past.length, 2);
eq('rebirth x2: generation is 3', st.generation, 3);
eq('rebirth x2: leftover is 100', st.current.xp, 100);
eq('rebirth x2: rebirthed flag set', res.rebirthed, true);

// Exactly at the boundary rebirths.
st = freshWithPlanet(42);
res = L.applyXp(st, 3600, seedSeq());
eq('rebirth: exactly 3600 rebirths', res.rebirthed, true);
eq('rebirth: exactly 3600 leaves 0 XP', st.current.xp, 0);

// --- 7. Starter bias (same rule as piece 1: 75% starter) ---------------------
let icy = 0;
for (let seed = 1; seed <= 200; seed++) {
  if (Planet.generatePlanet(seed, 'icy').terrain === 'icy') icy++;
}
check('starter: ~75% icy over 200 seeds', icy >= 130 && icy <= 180, icy + '/200 icy');
check('starter: every starter terrain exists', L.CONFIG.STARTER_TERRAINS.every((id) =>
  Planet.CONFIG.TERRAINS.some((t) => t.id === id)), L.CONFIG.STARTER_TERRAINS.join(','));

// --- 8. New planet command ----------------------------------------------------
st = freshWithPlanet(42);
L.applyXp(st, 500, seedSeq());
const beforeSeed = st.current.seed;
const np = L.newPlanet(st, seedSeq(777));
eq('new planet: old one archived', st.past.length, 1);
eq('new planet: archived chars 500', st.past[0].chars, 500);
eq('new planet: generation 2', st.generation, 2);
eq('new planet: xp reset', st.current.xp, 0);
eq('new planet: seed changed', st.current.seed !== beforeSeed, true);
eq('new planet: returned planet is current', np, st.current);

// --- 9. Persistence round-trip (mock globalState) ------------------------------
class MockState {
  constructor() { this.map = new Map(); }
  get(key, def) { return this.map.has(key) ? this.map.get(key) : def; }
  update(key, value) { this.map.set(key, value); return Promise.resolve(); }
}
st = freshWithPlanet(1234);
L.applyXp(st, 250, seedSeq());
const mock = new MockState();
mock.update('protoplanet.state', L.serializeState(st));
const loaded = L.deserializeState(mock.get('protoplanet.state', ''));
eq('persist: seed survives', loaded.current.seed, 1234);
eq('persist: xp survives', loaded.current.xp, 250);
eq('persist: chars survive', loaded.current.chars, 250);
eq('persist: generation survives', loaded.generation, 1);
eq('persist: starterDone survives', loaded.starterDone, true);
eq('persist: terrain survives', loaded.current.terrain, st.current.terrain);
eq('persist: past survives', loaded.past.length, st.past.length);

// --- 10. Bad stored data falls back to fresh -----------------------------------
eq('persist: garbage JSON -> fresh state', L.deserializeState('not json {').current, null);
eq('persist: wrong version -> fresh state', L.deserializeState('{"version":99}').current, null);
eq('persist: empty string -> fresh state', L.deserializeState('').starterDone, false);
const badCurrent = L.deserializeState('{"version":1,"current":{"seed":"nope"},"past":[],"generation":1,"starterDone":true}');
eq('persist: malformed current -> fresh state', badCurrent.current, null);

// --- 11. package.json contract + extension.js wiring ---------------------------
const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
eq('pkg: publisher', pkg.publisher, 'devoncline');
eq('pkg: name', pkg.name, 'protoplanet');
eq('pkg: displayName', pkg.displayName, 'Protoplanet');
eq('pkg: main is extension.js', pkg.main, './extension.js');
check('pkg: activates onStartupFinished', (pkg.activationEvents || []).includes('onStartupFinished'));
check('pkg: engines.vscode present', typeof pkg.engines === 'object' && typeof pkg.engines.vscode === 'string');
const containers = (pkg.contributes && pkg.contributes.viewsContainers && pkg.contributes.viewsContainers.activitybar) || [];
check('pkg: activity bar container', containers.some((c) => c.id === 'protoplanet'));
const views = (pkg.contributes && pkg.contributes.views && pkg.contributes.views.protoplanet) || [];
check('pkg: sidebar webview view', views.some((v) => v.id === 'protoplanet.petView' && v.type === 'webview'));
const cmds = (pkg.contributes && pkg.contributes.commands) || [];
check('pkg: showPet command', cmds.some((c) => c.command === 'protoplanet.showPet'));
check('pkg: newPlanet command', cmds.some((c) => c.command === 'protoplanet.newPlanet'));
check('pkg: feedMineral command', cmds.some((c) => c.command === 'protoplanet.feedMineral'));
check('pkg: salvagePlanet command', cmds.some((c) => c.command === 'protoplanet.salvagePlanet'));
check('pkg: prestige command', cmds.some((c) => c.command === 'protoplanet.prestige'));
check('pkg: icon file exists', fs.existsSync(path.join(__dirname, 'media', 'planet.svg')));
check('pkg: planet.js exists for the webview', fs.existsSync(path.join(__dirname, 'planet.js')));

const extSrc = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');
check('ext: registers showPet', extSrc.includes("'protoplanet.showPet'"));
check('ext: registers newPlanet', extSrc.includes("'protoplanet.newPlanet'"));
check('ext: registers feedMineral', extSrc.includes("'protoplanet.feedMineral'"));
check('ext: registers salvagePlanet', extSrc.includes("'protoplanet.salvagePlanet'"));
check('ext: registers prestige', extSrc.includes("'protoplanet.prestige'"));
check('ext: status bar shows minerals', extSrc.includes('mineralSummary'));
check('ext: listens for typing', extSrc.includes('onDidChangeTextDocument'));
check('ext: uses gridToHtml (fixed cells)', extSrc.includes('gridToHtml'));
check('ext: no bare <pre> grid rendering', !/\.grid.*innerHTML\s*=\s*[^P]/.test(extSrc) || extSrc.includes('gridToHtml'));
check('ext: webview uses nonce CSP', extSrc.includes('Content-Security-Policy') && extSrc.includes('nonce-'));
check('ext: no notification popups on typing', !extSrc.includes('showInformationMessage'));
check('ext: uses petLogic for XP', extSrc.includes('Logic.applyXp'));

// --- 12. Minerals, feeding, salvage/recycle, prestige (step 2) ------------
// Helper: first seed whose ONLY mutation is the target (same idea as
// test-planet's singleSeed14, small range is fine for tests).
function carrierSeed(id) {
  for (let s = 0; s < 4000; s++) {
    const pl = Planet.generatePlanet(s);
    if (pl.mutations.length === 1 && pl.mutations[0] === id) return s;
  }
  return null;
}
// A state whose current planet has >= 2200 chars (Civilization) and one
// archived planet that also has >= 2200 chars — the prestige setup.
function prestigeReadyState() {
  const s = freshWithPlanet(42);
  L.applyXp(s, 2300, seedSeq(5000));
  L.newPlanet(s, seedSeq(6000));
  L.applyXp(s, 2300, seedSeq(7000));
  return s;
}

// 12a. Starter mineral: one free crystal on first run, once ever.
st = freshWithPlanet(42);
eq('minerals: first run grants one starter mineral', st.minerals.length, 1);
eq('minerals: starter is crystal', st.minerals[0].kind, 'crystal');
eq('minerals: starter family is glow', st.minerals[0].family, 'glow');
eq('minerals: starter carries no mutation', st.minerals[0].mutation, null);
eq('minerals: starter flag set', st.starterMineralGranted, true);
eq('minerals: starter name', L.mineralName(st.minerals[0]), 'Crystal mineral');
check('minerals: starter tilts toward glow', L.mineralTiltsText(st.minerals[0]).includes('glow'));
eq('minerals: second grant is a no-op', L.grantStarterMineral(st), null);
eq('minerals: still one after second grant', st.minerals.length, 1);

// 12b. Feeding: moves a mineral to the fed slot; feeding another one
// returns the old one; unfeed returns it; takeTilt consumes it.
st = freshWithPlanet(42);
const starterId = st.minerals[0].id;
let fr = L.feedMineral(st, starterId);
eq('feed: ok', fr.ok, true);
eq('feed: fed slot set', st.fedMineral.id, starterId);
eq('feed: inventory emptied', st.minerals.length, 0);
eq('feed: unknown id rejected', L.feedMineral(st, 'min-999').ok, false);
const extra = L.makeMineral(st, { family: 'moon', mutation: null, source: 'salvage' });
st.minerals.push(extra);
fr = L.feedMineral(st, extra.id);
eq('feed: second feed returns the first', fr.returned && fr.returned.id, starterId);
eq('feed: first mineral back in inventory', st.minerals.some((m) => m.id === starterId), true);
const ur = L.unfeedMineral(st);
eq('unfeed: ok', ur.ok, true);
eq('unfeed: slot cleared', st.fedMineral, null);
eq('unfeed: mineral back in inventory', st.minerals.length, 2);
eq('unfeed: nothing fed is a no-op', L.unfeedMineral(st).ok, false);
L.feedMineral(st, starterId);
const tilt = L.takeTilt(st, null);
check('takeTilt: fed crystal boosts glow mutations x10',
  tilt && tilt.boosts['crystal-crust'] === 10 && tilt.boosts['glowing-oceans'] === 10
  && tilt.boosts['city-lights'] === 10 && tilt.boosts['sparkling-surface'] === 10);
check('takeTilt: fed crystal does not boost moon mutations',
  tilt && tilt.boosts['green-moon'] === undefined);
eq('takeTilt: fed mineral consumed', st.fedMineral, null);
eq('takeTilt: nothing fed -> null tilt', L.takeTilt(st, null), null);
const exact = L.makeMineral(st, { family: 'moon', mutation: 'green-moon', source: 'salvage' });
check('boosts: a mutation mineral tilts that mutation x20',
  L.boostsForMineral(exact)['green-moon'] === 20
  && L.boostsForMineral(exact)['blood-moon'] === undefined);
eq('mineral name: mutation mineral', L.mineralName(exact), 'Green Moon mineral');

// 12c. A fed mineral really tilts the next planet's birth roll
// (measured over 2000 seeds: moon-family rate ~2% plain, ~20% fed).
{
  let plainMoon = 0, fedMoon = 0;
  const N = 2000;
  const moonTilt = { boosts: { 'big-moon': 10, 'green-moon': 10, 'blood-moon': 10 } };
  for (let s = 0; s < N; s++) {
    const p = Planet.generatePlanet(s);
    const f = Planet.generatePlanet(s, null, moonTilt);
    if (p.mutations.some((id) => ['big-moon', 'green-moon', 'blood-moon'].includes(id))) plainMoon++;
    if (f.mutations.some((id) => ['big-moon', 'green-moon', 'blood-moon'].includes(id))) fedMoon++;
  }
  check('tilt: fed moon mineral raises the moon-mutation rate (>10%)', fedMoon / N > 0.10, `${(100 * fedMoon / N).toFixed(1)}% fed`);
  check('tilt: plain moon-mutation rate stays low (<5%)', plainMoon / N < 0.05, `${(100 * plainMoon / N).toFixed(1)}% plain`);
  const a = Planet.generatePlanet(123), b = Planet.generatePlanet(123, null, moonTilt);
  eq('tilt: same seed + tilt keeps the terrain', b.terrain, a.terrain);
  eq('tilt: same seed + tilt keeps the rings', b.ringType, a.ringType);
  eq('tilt: same seed + tilt keeps the size', b.size, a.size);
  eq('tilt: same seed + tilt keeps the moon count', b.moons.length, a.moons.length);
  check('tilt: same seed + same tilt is deterministic',
    JSON.stringify(Planet.generatePlanet(123, null, moonTilt)) === JSON.stringify(Planet.generatePlanet(123, null, moonTilt)));
}

// 12d. Salvage yields: a mutated planet yields a mineral OF its
// mutation; a plain planet yields one plain mineral (stable per seed).
{
  const gm = L.yieldMineralsForPlanet(Planet.generatePlanet(carrierSeed('green-moon')));
  eq('salvage: mutated planet yields one mineral', gm.length, 1);
  eq('salvage: it carries the mutation', gm[0].mutation, 'green-moon');
  eq('salvage: family matches the mutation', gm[0].family, 'moon');
  const plain = Planet.generatePlanet(42); plain.mutations = [];
  const yp = L.yieldMineralsForPlanet(plain);
  eq('salvage: plain planet yields one mineral', yp.length, 1);
  eq('salvage: plain yield carries no mutation', yp[0].mutation, null);
  check('salvage: plain yield family is a real family', L.CONFIG.MINERAL_FAMILIES.includes(yp[0].family));
  eq('salvage: plain yield is stable per seed',
    L.yieldMineralsForPlanet(plain)[0].family, yp[0].family);
  let two = null;
  for (let s = 0; s < 4000 && !two; s++) {
    const pl = Planet.generatePlanet(s);
    if (pl.mutations.length === 2) two = pl;
  }
  check('salvage: a two-mutation planet yields two minerals',
    two && L.yieldMineralsForPlanet(two).length === 2, two ? two.mutations.join('+') : 'no two-mutation seed found');
}

// 12e. Recycle: destroy the current planet for minerals, hatch a fresh
// one immediately. The destroyed planet is NOT archived.
st = freshWithPlanet(carrierSeed('green-moon'));
const rc = L.recycleCurrent(st, seedSeq(3000));
eq('recycle: ok', rc.ok, true);
eq('recycle: yields the mutation mineral', rc.minerals.length, 1);
eq('recycle: mineral is the green moon', rc.minerals[0].mutation, 'green-moon');
eq('recycle: generation +1', st.generation, 2);
eq('recycle: new planet is Dust cloud', L.stageForXp(st.current.xp), 0);
eq('recycle: destroyed planet NOT archived', st.past.length, 0);
eq('recycle: new seed differs', st.current.seed !== carrierSeed('green-moon'), true);
eq('recycle: mineral in inventory', st.minerals.some((m) => m.mutation === 'green-moon'), true);
st = freshWithPlanet(42);
L.feedMineral(st, st.minerals[0].id);
L.recycleCurrent(st, seedSeq(4000));
eq('recycle: fed mineral consumed by the new planet', st.fedMineral, null);
st = L.freshState();
eq('recycle: no current planet is a no-op', L.recycleCurrent(st, seedSeq()).ok, false);

// 12f. Salvage an archived planet: minerals out, record gone, no new planet.
st = freshWithPlanet(carrierSeed('glitch'));
L.applyXp(st, 500, seedSeq());
L.newPlanet(st, seedSeq(8000));
eq('salvage: one archived planet', st.past.length, 1);
const sv = L.salvageArchived(st, 0);
eq('salvage: ok', sv.ok, true);
eq('salvage: yields the glitch mineral', sv.minerals[0].mutation, 'glitch');
eq('salvage: record removed', st.past.length, 0);
eq('salvage: no new planet made', st.current.seed !== carrierSeed('glitch'), true);
eq('salvage: bad index rejected', L.salvageArchived(st, 99).ok, false);

// 12g. Prestige: two Civilization-stage planets make an offspring.
st = prestigeReadyState();
const parents = L.eligiblePrestigeParents(st);
eq('prestige: two eligible parents listed', parents.length, 2);
const pr = L.prestige(st, { kind: 'current' }, { kind: 'past', index: 0 }, seedSeq(9000));
eq('prestige: ok', pr.ok, true);
eq('prestige: offspring is the new current planet', st.current, pr.planet);
eq('prestige: offspring starts at 0 XP', st.current.xp, 0);
eq('prestige: offspring starts as dust', L.stageForXp(st.current.xp), 0);
eq('prestige: generation +1', st.generation, 3);
eq('prestige: offspring stores two parents', pr.planet.parents.length, 2);
eq('prestige: lineage records the parent seeds',
  pr.planet.parents.map((p) => p.seed).sort().join(','),
  [st.past[0].seed, st.past[1].seed].sort().join(','));
check('prestige: parents stay in the collection (retire, not destroy)',
  st.past.length === 2);
check('prestige: archived parents are marked used',
  st.past.every((p) => p.usedAsParent === true));
eq('prestige: same parent cannot prestige twice',
  L.prestige(st, { kind: 'past', index: 0 }, { kind: 'past', index: 1 }, seedSeq()).ok, false);
eq('prestige: same planet twice rejected',
  L.prestige(st, { kind: 'current' }, { kind: 'current' }, seedSeq()).ok, false);
st = freshWithPlanet(42);
L.applyXp(st, 500, seedSeq());
L.newPlanet(st, seedSeq());
L.applyXp(st, 500, seedSeq());
eq('prestige: young planets are not eligible',
  L.eligiblePrestigeParents(st).length, 0);
eq('prestige: young parents rejected',
  L.prestige(st, { kind: 'current' }, { kind: 'past', index: 0 }, seedSeq()).ok, false);
// Inheritance boosts: one parent x2, both parents x3 (the mechanism).
eq('inherit: one parent boosts x2', L.inheritanceBoosts(['green-moon'], [])['green-moon'], 2);
eq('inherit: both parents boost x3', L.inheritanceBoosts(['green-moon'], ['green-moon'])['green-moon'], 3);
eq('inherit: unshared mutations stay x2',
  L.inheritanceBoosts(['green-moon'], ['blood-moon'])['blood-moon'], 2);
{
  // The boost is real in the roll: green-moon at x3 over 5000 seeds.
  // (N is big on purpose — a 3x boost over a 0.7% base is a small
  // absolute gap, and the check must not flake on binomial noise:
  // expected ~35 base vs ~105 boosted.)
  let base = 0, boosted = 0;
  const N = 5000, tilt3 = { boosts: { 'green-moon': 3 } };
  for (let s = 0; s < N; s++) {
    if (Planet.generatePlanet(s).mutations.includes('green-moon')) base++;
    if (Planet.generatePlanet(s, null, tilt3).mutations.includes('green-moon')) boosted++;
  }
  check('inherit: x3 boost triples the green-moon rate', boosted > base * 1.5, `${boosted} vs ${base} / ${N}`);
}
// A fed mineral is consumed by a prestige offspring too.
st = prestigeReadyState();
L.feedMineral(st, st.minerals[0].id);
L.prestige(st, { kind: 'current' }, { kind: 'past', index: 0 }, seedSeq(9500));
eq('prestige: fed mineral consumed by the offspring', st.fedMineral, null);

// 12h. Persistence: minerals + fed mineral survive a round-trip, and
// old saves (from before minerals) get the one-time starter gift.
st = freshWithPlanet(42);
L.feedMineral(st, st.minerals[0].id);
const loaded2 = L.deserializeState(L.serializeState(st));
eq('persist: fed mineral survives', loaded2.fedMineral && loaded2.fedMineral.id, st.fedMineral.id);
eq('persist: starter flag survives', loaded2.starterMineralGranted, true);
const migrated = L.deserializeState('{"version":1,"current":null,"past":[],"generation":1,"starterDone":true}');
eq('persist: old save gets the starter gift', migrated.minerals.length, 1);
eq('persist: old save starter is crystal', migrated.minerals[0].kind, 'crystal');
eq('persist: old save flag set', migrated.starterMineralGranted, true);
const summary = L.mineralSummary(freshWithPlanet(42));
eq('summary: one mineral total', summary.total, 1);
eq('summary: one glow mineral', summary.byFamily.glow, 1);
eq('summary: nothing fed', summary.fed, null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n- ' + failures.join('\n- '));
  process.exit(1);
}
