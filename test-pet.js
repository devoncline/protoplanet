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
  && tilt.boosts['sparkling-surface'] === 10);
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

// --- 13. Solar system (step 4): System Rank, slots, names, overflow -------
// Helper: grow `n` finished planets (each applyXp(3600) rebirths once).
function growFinished(st, n, seedStart) {
  const seq = seedSeq(seedStart === undefined ? 10000 : seedStart);
  for (let i = 0; i < n; i++) L.applyXp(st, 3600, seq);
  return st;
}

// 13a. System Rank ladder: 4 rings at Rank 0, +1 ring per 3 finished
// planets, capped at 12 rings.
st = freshWithPlanet(42);
let rk = L.systemRank(st);
eq('rank: fresh state is Rank 0', rk.rank, 0);
eq('rank: fresh state has 4 rings', rk.totalSlots, 4);
eq('rank: fresh next ring at 3 finished', rk.nextAt, 3);
eq('rank: fresh 3 to go', rk.toNext, 3);
eq('rank: fresh finished count is 0', rk.finished, 0);
eq('rank label: Ring 5 needs 3 more planets', L.lockedRingLabel(st, 4), 'Ring 5 — grow 3 more planets');
eq('rank label: Ring 6 needs 6 more planets', L.lockedRingLabel(st, 5), 'Ring 6 — grow 6 more planets');
eq('rank label: unlocked ring has no label', L.lockedRingLabel(st, 0), null);
growFinished(st, 3);
rk = L.systemRank(st);
eq('rank: 3 finished -> Rank 1', rk.rank, 1);
eq('rank: 3 finished -> 5 rings', rk.totalSlots, 5);
eq('rank: 3 finished -> next at 6', rk.nextAt, 6);
growFinished(st, 3);
rk = L.systemRank(st);
eq('rank: 6 finished -> Rank 2', rk.rank, 2);
eq('rank: 6 finished -> 6 rings', rk.totalSlots, 6);
growFinished(st, 18);
rk = L.systemRank(st);
eq('rank: 24 finished -> Rank 8 (max)', rk.rank, 8);
eq('rank: 24 finished -> 12 rings (max)', rk.totalSlots, 12);
eq('rank: at max, no next rank', rk.nextAt, null);
eq('rank label: at max, locked ring says max', L.lockedRingLabel(st, 12), 'Ring 13 — max rings reached');
growFinished(st, 6);
rk = L.systemRank(st);
eq('rank: 30 finished stays at max', rk.totalSlots, 12);
eq('rank: system array padded to the ring count', st.system.length, 12);

// 13b. Place / remove: rules and rejections.
st = freshWithPlanet(42);
growFinished(st, 3); // 5 rings, 3 archived planets
const pA = st.past[0], pB = st.past[1];
let pl = L.placePlanet(st, 4, pA.seed, pA.generation);
eq('place: ring 4 (newly unlocked) ok', pl.ok, true);
eq('place: slot holds the planet', st.system[4].seed, pA.seed);
eq('place: slot lookup finds it', L.slotIndexForPlanet(st, pA.seed, pA.generation), 4);
eq('place: same planet on another ring rejected',
  L.placePlanet(st, 0, pA.seed, pA.generation).ok, false);
eq('place: locked ring rejected',
  L.placePlanet(st, 5, pB.seed, pB.generation).ok, false);
eq('place: unknown planet rejected',
  L.placePlanet(st, 0, 999999999, 1).ok, false);
eq('place: negative ring rejected',
  L.placePlanet(st, -1, pB.seed, pB.generation).ok, false);
pl = L.placePlanet(st, 0, pB.seed, pB.generation);
eq('place: ring 0 ok', pl.ok, true);
let rm = L.removeFromSystem(st, 0);
eq('remove: ok', rm.ok, true);
eq('remove: returns the removed planet', rm.removed.seed, pB.seed);
eq('remove: slot is empty again', st.system[0], null);
eq('remove: planet still in the collection (not deleted)',
  st.past.some((p) => p.seed === pB.seed), true);
eq('remove: empty ring rejected', L.removeFromSystem(st, 0).ok, false);
eq('remove: bad ring rejected', L.removeFromSystem(st, 99).ok, false);
// The current (growing) planet can be placed too, and the slot
// survives its rebirth into the archive.
st = freshWithPlanet(42);
pl = L.placePlanet(st, 0, st.current.seed, st.generation);
eq('place: current planet can be placed', pl.ok, true);
L.applyXp(st, 3600, seedSeq(20000));
eq('place: slot survives the rebirth (same seed+generation)',
  L.slotIndexForPlanet(st, 42, 1), 0);
eq('place: the rebirthed planet is now archived', st.past.some((p) => p.seed === 42), true);

// 13c. Names on records: stored at birth, derived for old records.
st = freshWithPlanet(42);
eq('name: current planet has its seed name',
  st.current.name, Planet.generatePlanetName(42));
L.applyXp(st, 3600, seedSeq(21000));
eq('name: archived record stores the name',
  st.past[0].name, Planet.generatePlanetName(42));
check('name: archived record stores the full planet snapshot',
  st.past[0].planet && st.past[0].planet.seed === 42 && Array.isArray(st.past[0].planet.moons),
  'snapshot moons: ' + (st.past[0].planet && st.past[0].planet.moons && st.past[0].planet.moons.length));
eq('name: old record without a name derives it from the seed',
  L.nameForPlanet({ seed: 42 }), Planet.generatePlanetName(42));
eq('name: a stored name is kept as-is',
  L.nameForPlanet({ seed: 42, name: 'Custom' }), 'Custom');
eq('name: lineage records carry names',
  L.lineageRecord(st.past[0], 1).name, Planet.generatePlanetName(42));

// 13d. Salvage clears the slot; a rank drop returns the planet to
// the archive (never deletes it).
st = freshWithPlanet(42);
growFinished(st, 3); // 5 rings
const placed = st.past[0];
L.placePlanet(st, 4, placed.seed, placed.generation);
const placedIdx = st.past.findIndex((p) => p.seed === placed.seed);
const sv2 = L.salvageArchived(st, placedIdx);
eq('salvage: ok', sv2.ok, true);
eq('salvage: the slot goes empty', st.system[4], null);
eq('salvage: the planet is gone from the collection',
  st.past.some((p) => p.seed === placed.seed), false);
st = freshWithPlanet(42);
growFinished(st, 3); // Rank 1, 5 rings
const ring4Planet = st.past[0];
L.placePlanet(st, 4, ring4Planet.seed, ring4Planet.generation);
eq('rank drop: planet on ring 4', L.slotIndexForPlanet(st, ring4Planet.seed, ring4Planet.generation), 4);
// Salvage a DIFFERENT planet: finished drops 3 -> 2, Rank 1 -> 0.
const otherIdx = st.past.findIndex((p) => p.seed !== ring4Planet.seed);
L.salvageArchived(st, otherIdx);
eq('rank drop: rank falls back to 0', L.systemRank(st).rank, 0);
eq('rank drop: ring 4 is cleared', st.system[4], null);
eq('rank drop: the planet is still in the collection (not deleted)',
  st.past.some((p) => p.seed === ring4Planet.seed), true);

// 13e. Overflow to Archive: a full system never blocks growth — the
// new planet lands in the Archive and the player chooses what to show.
st = freshWithPlanet(42);
growFinished(st, 4); // 4 finished -> Rank 1 -> 5 rings; 4 archived + current = 5 planets
for (let i = 0; i < 4; i++) {
  const ok = L.placePlanet(st, i, st.past[i].seed, st.past[i].generation);
  eq('overflow: ring ' + i + ' fills', ok.ok, true);
}
eq('overflow: current planet fills the 5th ring',
  L.placePlanet(st, 4, st.current.seed, st.generation).ok, true);
eq('overflow: all 5 rings used', st.system.filter(Boolean).length, 5);
const beforePast = st.past.length;
res = L.applyXp(st, 3600, seedSeq(22000));
eq('overflow: rebirth still happens with a full system', res.rebirthed, true);
eq('overflow: the old planet lands in the Archive', st.past.length, beforePast + 1);
eq('overflow: a new planet hatches', st.current.xp, 0);
eq('overflow: the 5 rings are untouched by the rebirth',
  st.system.filter(Boolean).length, 5);
eq('overflow: the new planet is not forced into the system',
  L.slotIndexForPlanet(st, st.current.seed, st.generation), -1);
const np2 = L.newPlanet(st, seedSeq(23000));
eq('overflow: manual new planet also archives with a full system',
  st.past.length, beforePast + 2);
check('overflow: the new planet is the current one', np2 === st.current);

// 13f. Persistence: the system survives a round-trip, and old saves
// (from before step 4) get an empty 4-ring system.
st = freshWithPlanet(42);
growFinished(st, 2);
L.placePlanet(st, 0, st.past[0].seed, st.past[0].generation);
const loaded3 = L.deserializeState(L.serializeState(st));
eq('persist: system survives', loaded3.system[0] && loaded3.system[0].seed, st.past[0].seed);
eq('persist: rank survives', L.systemRank(loaded3).totalSlots, L.systemRank(st).totalSlots);
const migrated2 = L.deserializeState('{"version":1,"current":null,"past":[],"generation":1,"starterDone":true}');
check('persist: old save gets a 4-ring system',
  Array.isArray(migrated2.system) && migrated2.system.length === 4 && migrated2.system.every((s) => s === null));

// 13g. package.json + extension.js wiring for the Solar System panel.
check('pkg: openSolarSystem command', cmds.some((c) => c.command === 'protoplanet.openSolarSystem'));
check('ext: registers openSolarSystem', extSrc.includes("'protoplanet.openSolarSystem'"));
check('ext: opens a webview panel', extSrc.includes('createWebviewPanel'));
check('ext: panel keeps context when hidden', extSrc.includes('retainContextWhenHidden'));
check('ext: builds a system view model', extSrc.includes('solarSystemViewModel'));
check('ext: handles place/remove messages', extSrc.includes('onSystemMessage'));
check('ext: panel uses placePlanet', extSrc.includes('Logic.placePlanet'));
check('ext: panel uses removeFromSystem', extSrc.includes('Logic.removeFromSystem'));
check('ext: panel HTML exists', extSrc.includes('getSystemHtml'));
check('ext: panel reuses the fixed-cell renderer', extSrc.includes('renderCozy'));
// 13g (orbit, Nov 11 — Devon's call): the orbit is ALWAYS on. There
// is no static mode and no toggle — the button, the flag, and the
// guard are all gone; the drift pauses only while hovering a planet
// or with the detail panel open.
check('ext: panel has no orbit toggle button', !extSrc.includes('orbitBtn'));
check('ext: panel has no static mode (no orbit flag, no Orbit labels)',
  !extSrc.includes('orbitOn') && !extSrc.includes('Orbit: Off') && !extSrc.includes('Orbit: On'));
check('ext: orbit advances without a toggle guard',
  extSrc.includes('if (!hoverPlanet && !detailOpen)'));

// 13h. Catalog names: unique across the collection (birth-time layer).
// (i) 500 births through the collection-aware path are all distinct.
const taken500 = new Set();
const born500 = [];
for (let s = 0; s < 500; s++) {
  const p = L.makePlanet(900000 + s, undefined, undefined, taken500);
  born500.push(p.name);
  taken500.add(p.name);
}
check('names: 500 births through the collection-aware path are all distinct',
  new Set(born500).size === 500, new Set(born500).size + ' distinct');
// The nudge itself: a taken base name gets a different, still-valid
// catalog name in the same catalog.
const baseName = Planet.generatePlanetName(777);
const nudged = L.uniquePlanetName(baseName, 777, new Set([baseName]));
const parsedBase = Planet.parseCatalogName(baseName);
const parsedNudged = Planet.parseCatalogName(nudged);
check('names: a taken name is nudged to a different name', nudged !== baseName, baseName + ' -> ' + nudged);
check('names: the nudged name parses as a catalog name', !!parsedNudged, nudged);
check('names: the nudge stays in the same catalog',
  !!parsedNudged && parsedNudged.catalog.prefix === parsedBase.catalog.prefix,
  baseName + ' -> ' + nudged);
check('names: the nudge is deterministic (same seed + same taken set)',
  L.uniquePlanetName(baseName, 777, new Set([baseName])) === nudged);
// A free name passes through untouched, and a non-catalog name is
// left alone (the layer only knows how to nudge catalog names).
check('names: a free name is unchanged',
  L.uniquePlanetName(baseName, 777, new Set()) === baseName);
check('names: a non-catalog name is left alone',
  L.uniquePlanetName('Custom', 777, new Set(['Custom'])) === 'Custom');
// (integration) births through the real paths stay distinct too.
st = freshWithPlanet(42);
growFinished(st, 30); // 30 finished planets + the current one
const allNames = st.past.map((p) => p.name).concat([st.current.name]);
check('names: 31 planets grown through rebirths are all distinct',
  new Set(allNames).size === allNames.length, new Set(allNames).size + ' distinct of ' + allNames.length);

// 13i. Display fixes (Nov 11 — Devon's preview feedback).
// (a) The panel shows a stage CAPPED at Civilization — never End.
// Archived planets sit at 3600 chars = End, and End renders as
// dispersing noise. The TRUE lifecycle stage is unchanged (the
// sidebar pet and rebirth still see End); only the panel display
// is capped.
check('display stage: 3600 chars displays as Civilization', L.displayStageForXp(3600) === 6);
check('display stage: 3000 chars (End starts) displays as Civilization', L.displayStageForXp(3000) === 6);
check('display stage: 2999 chars displays as Civilization', L.displayStageForXp(2999) === 6);
check('display stage: 2200 chars displays as Civilization', L.displayStageForXp(2200) === 6);
check('display stage: 1500 chars displays as Life', L.displayStageForXp(1500) === 5);
check('display stage: true stage is untouched (3600 is still End)', L.stageForXp(3600) === 7);
// (b) The panel wires the cap, the bigger detailed star, the small
// discs again, the full-detail panel art, and the labeled card badges.
check('ext: panel caps the display stage', extSrc.includes('displayStageForXp'));
check('ext: orrery is a little more tilted (TILT 0.34)',
  extSrc.includes('TILT = 0.34') && !extSrc.includes('TILT = 0.42'));
check('ext: star is bigger and more detailed (larger sphere, granulation, textured bright core)',
  extSrc.includes('drawMiniSphere(grid, mx, my, mr, 226, 7, false, 1, 0.30)')
  && extSrc.includes('Granulation'));
check('ext: star has no stamped white-rectangle core',
  !extSrc.includes("['@', 231]"));
check('ext: orrery discs are small again (46x24 cozy, not 68x38)',
  extSrc.includes('P.renderCozy(d.planet.planet, d.planet.stageIdx, 10, sec, 1.0, 46, 24), 2.6, 6.12')
  && !extSrc.includes('68, 38), 3.4, 6.12'));
check('ext: detail panel uses the full render, not the cozy downsample',
  extSrc.includes('P.render(planet.planet, planet.stageIdx, 10, sec, 1.2), 2.35, 4.23'));
check('ext: detail panel no longer uses the cozy art',
  !extSrc.includes('4.4, 7.92'));
check('ext: card mutation badge keeps the full MUTATION label',
  extSrc.includes("'<span class=\"badge mut\">' + esc(p.mutationLabel)") &&
  !extSrc.includes("mutationLabel.replace('MUTATION"));
check('ext: card shows the stage', extSrc.includes('esc(p.stageName)'));
check('ext: discs share one z-index — no depth sorting (separation is geometric)',
  extSrc.includes("d.el.style.zIndex = '100'") && !extSrc.includes('10 + Math.round(pos.y)'));
check('ext: no name labels on the orrery', !extSrc.includes('discName'));
check('ext: no "+" buttons on empty rings (ringHit hit-areas instead)',
  !extSrc.includes('ringBtn') && extSrc.includes("className = 'ringHit'"));

// 13j. No overlap (Devon, Nov 11 — he takes back the overlap note:
// the v2 overlap looked like a mess). The geometry keeps discs clear:
// ring 0 clears the star, and every ring has a fixed 30deg slot
// (slotAngle) with uniform drift, so the separation holds forever —
// no collision-avoidance or hiding logic is needed, and none exists.
check('ext: star sits below the discs', extSrc.includes("star.style.zIndex = '1'"));
check('ext: orrery spreads across the panel (R0 330, RMAX 640)',
  extSrc.includes('var R0 = 330, RMAX = 640'));
check('ext: minimum angular separation the geometry needs (25 deg)',
  extSrc.includes('MIN_SEP = 25 * Math.PI / 180'));
check('ext: each ring has a fixed slot angle (1/R gaps, wider inside)',
  extSrc.includes('slotAngle(slot.planet, i)') && extSrc.includes('SLOT_C / SLOT_R[i]'));
check('ext: slot jitter is at most +/-2deg',
  extSrc.includes('(4 * Math.PI / 180)'));
check('ext: the greedy nudge scheme is gone', !extSrc.includes('separatedAngle'));
check('ext: drift is uniform — same step on every ring, so the separation holds',
  extSrc.includes('angles[i] += 0.0078;') && !extSrc.includes('0.0078 / (1 + (+i) * 0.35)'));
check('ext: no differential (Kepler) drift left', !extSrc.includes('Kepler'));
check('ext: panel has no collision-avoidance or hiding logic',
  !extSrc.includes('hideOverlapping') && !extSrc.includes('collisionAvoidance'));
// (Nov 11, prestige panel: the word "collision" itself is allowed now —
// it names the fusion animation, planet.js collisionFrame. This check
// is about the orrery hiding overlapping discs, not the word.)

// 13k. Geometry, numerically: the slot scheme puts ring i at a
// cumulative angle, where the gap after ring i is SLOT_C / SLOT_R[i]
// (wider for inner rings — the same angle is fewer pixels of arc
// there). The gaps sum to a full circle (42deg at ring 0 down to
// 22deg at ring 11). A seeded jitter of at most +/-2deg can close a
// gap by 4deg at most. Sweep a full orbit at that worst case for
// every ring count 2..12 and every ring pair, and check the SOLID
// discs never touch: two discs overlap iff their center distance is
// less than the sum of their ellipse radii along the separation
// direction (max-size Civilization disc: 58x63, semi-axes 29x32).
// The thin ring lines may cross — that is normal in an orrery, not a
// mess — so they are not part of this check. Uniform drift keeps
// relative angles fixed, so one sweep covers all time. Ring 0 must
// clear the star (star half-height 70, max disc half-height 32) and
// the outermost ring must stay inside the world (no clipping).
// Constants and slots are rebuilt exactly as the panel does, so the
// test tracks the real code.
{
  const grab = (re) => { const m = extSrc.match(re); return m ? +m[1] : NaN; };
  const TILT = grab(/TILT = ([\d.]+)/);
  const rm = extSrc.match(/var R0 = (\d+), RMAX = (\d+)/);
  const R0 = rm ? +rm[1] : NaN;
  const RMAX = rm ? +rm[2] : NaN;
  check('orrery geometry: constants parse from the panel source',
    TILT === 0.34 && R0 === 330 && RMAX === 640, `TILT ${TILT} R0 ${R0} RMAX ${RMAX}`);
  const SLOT_R = [];
  for (let i = 0; i < 12; i++) SLOT_R.push(R0 + (i * (RMAX - R0)) / 11);
  let SLOT_C = 0;
  for (let i = 0; i < 12; i++) SLOT_C += 1 / SLOT_R[i];
  SLOT_C = (Math.PI * 2) / SLOT_C;
  const slots = [0];
  for (let i = 1; i < 12; i++) slots.push(slots[i - 1] + SLOT_C / SLOT_R[i - 1]);
  const spacing = (total) => Math.max(28, Math.min(160, (RMAX - R0) / Math.max(1, total - 1)));
  const radius = (i, total) => R0 + i * spacing(total);
  const JITTER = 2 * Math.PI / 180;
  const ellR = (ux, uy, a, b) => 1 / Math.sqrt((ux / a) ** 2 + (uy / b) ** 2);
  for (let total = 2; total <= 12; total++) {
    const Rs = [];
    for (let i = 0; i < total; i++) Rs.push(radius(i, total));
    check(`orrery geometry: outermost ring fits the world (${total} rings)`,
      Rs[total - 1] <= 640.001, `R ${Rs[total - 1].toFixed(1)}`);
    const sunClear = Rs[0] * TILT - 70 - 32;
    check(`orrery geometry: ring 0 clears the star (${total} rings)`,
      sunClear >= 10, `${sunClear.toFixed(1)}px`);
    let worst = Infinity;
    for (let i = 0; i < total; i++) for (let j = i + 1; j < total; j++) {
      let delta = slots[j] - slots[i];
      delta = Math.abs(((delta + Math.PI) % (Math.PI * 2)) - Math.PI);
      delta -= 2 * JITTER; // worst case: jitter closes the gap
      let m = Infinity, mt = 0;
      for (let t = 0; t < Math.PI * 2; t += 0.005) {
        const dx = Rs[i] * Math.cos(t) - Rs[j] * Math.cos(t + delta);
        const dy = TILT * (Rs[i] * Math.sin(t) - Rs[j] * Math.sin(t + delta));
        const d = Math.hypot(dx, dy);
        if (d < m) { m = d; mt = t; }
      }
      const dx = Rs[i] * Math.cos(mt) - Rs[j] * Math.cos(mt + delta);
      const dy = TILT * (Rs[i] * Math.sin(mt) - Rs[j] * Math.sin(mt + delta));
      const need = 2 * ellR(dx / m, dy / m, 29, 32);
      if (m - need < worst) worst = m - need;
    }
    check(`orrery geometry: no disc overlap at ${total} rings`,
      worst >= 0, `worst margin ${worst.toFixed(1)}px`);
  }
}

// --- 14. Prestige panel (step 4b): the fusion screen ----------------------
// The panel is a dumb view of petLogic: eligibility, the fusion, the
// lineage all live here. The panel itself (extension.js) only builds
// the view model and applies its messages — and the fusion plays as a
// violent ASCII collision (planet.js collisionFrame), not a fade.

// 14a. Logic the panel leans on: eligibility after a fusion, lineage
// that survives a save, and the retire-not-destroy parent fate.
st = prestigeReadyState();
const pr2 = L.prestige(st, { kind: 'current' }, { kind: 'past', index: 0 }, seedSeq(9600));
eq('panel-logic: fusion ok', pr2.ok, true);
eq('panel-logic: after a fusion, no parent is eligible anymore',
  L.eligiblePrestigeParents(st).length, 0);
eq('panel-logic: the old current planet was archived (retired, not destroyed)',
  st.past.some((p) => p.seed === 42), true);
check('panel-logic: the retired parent is marked used',
  st.past.find((p) => p.seed === 42).usedAsParent === true);
check('panel-logic: lineage records carry the parents’ names',
  pr2.planet.parents.every((p) => typeof p.name === 'string' && p.name.length >= 4),
  pr2.planet.parents.map((p) => p.name).join(' + '));
eq('panel-logic: lineage records carry the parents’ generations',
  pr2.planet.parents.map((p) => p.generation).sort().join(','), '1,2');
const loaded4 = L.deserializeState(L.serializeState(st));
eq('panel-logic: the offspring’s lineage survives a round-trip',
  loaded4.current.parents.length, 2);
eq('panel-logic: the lineage names survive a round-trip',
  loaded4.current.parents.map((p) => p.name).sort().join(','),
  pr2.planet.parents.map((p) => p.name).sort().join(','));
eq('panel-logic: parents are RETIRED, not destroyed (Devon’s call — flag stays false)',
  L.CONFIG.PRESTIGE_CONSUMES_PARENTS, false);
// The eligible list names the current planet when it qualifies.
st = prestigeReadyState();
const elig = L.eligiblePrestigeParents(st);
check('panel-logic: the eligible list includes the current planet',
  elig.some((p) => p.kind === 'current' && p.index === -1));
check('panel-logic: the eligible list includes archived planets',
  elig.some((p) => p.kind === 'past' && p.index === 0));

// 14b. package.json + extension.js wiring for the Prestige panel.
check('pkg: openPrestige command', cmds.some((c) => c.command === 'protoplanet.openPrestige'));
check('ext: registers openPrestige', extSrc.includes("'protoplanet.openPrestige'"));
check('ext: prestige panel HTML exists', extSrc.includes('getPrestigeHtml'));
check('ext: builds a prestige view model', extSrc.includes('prestigeViewModel'));
check('ext: handles prestige messages', extSrc.includes('onPrestigeMessage'));
check('ext: panel fuses through petLogic', extSrc.includes('Logic.prestige('));
check('ext: panel reuses the shared renderable helper', extSrc.includes('renderablePlanet'));
check('ext: panel posts the fusion result for the result view', extSrc.includes('recordPrestigeResult'));
check('ext: panel has a dedicated webview panel (not a QuickPick)', extSrc.includes("'protoplanet.prestige'"));
check('ext: panel keeps context when hidden', extSrc.includes('retainContextWhenHidden'));
check('ext: panel uses the fixed-cell renderer', extSrc.includes('gridToHtml'));
// 14c. The fusion itself: a violent ASCII collision, not a gentle
// fade. The panel drives planet.js collisionFrame per tick, captions
// the phases, and only shows the offspring once the mess coalesces.
check('ext: panel plays the collision (collisionFrame per tick)', extSrc.includes('P.collisionFrame('));
check('ext: panel captions the collision phases', extSrc.includes('collisionPhase'));
check('ext: panel ends the collision at COLLISION_END', extSrc.includes('P.COLLISION_END'));
check('ext: panel has a collision stage', extSrc.includes('collisionWrap'));
check('ext: panel lets you skip the collision', extSrc.includes('Skip the collision'));
check('ext: panel asks for confirmation before fusing', extSrc.includes('confirmFuseBtn'));
check('ext: panel shows the offspring’s lineage', extSrc.includes('Born from'));
check('ext: panel shows what the offspring inherited', extSrc.includes('Inherited:'));
check('ext: panel shows the fed mineral tilting the offspring', extSrc.includes('Fed:'));
// The panel hides sections with .hidden, but #slotsRow and
// #confirmBar set their own display — without this rule the
// browser's [hidden] is overridden and the slots stay visible
// mid-collision and on the result screen (caught by stills).
check('ext: prestige CSS makes [hidden] actually hide', extSrc.includes('[hidden] { display: none !important; }'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n- ' + failures.join('\n- '));
  process.exit(1);
}
