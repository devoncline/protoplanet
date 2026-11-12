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
eq('stage: 3000 xp -> Civilization (final)', L.stageForXp(3000), 6);
eq('stage: 3599 xp -> Civilization (final)', L.stageForXp(3599), 6);
eq('thresholds: 7 stages', T.length, 7);
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
eq('progress: 3200 xp is stage 6 (Civilization, final)', info.stageIdx, 6);
eq('progress: Civilization has no next threshold (no auto-rebirth)', info.nextXp, null);
eq('progress: Civilization has no span (no next stage)', info.span, null);
eq('progress: Civilization is maxed', info.isMax, true);
eq('progress: Civilization stage start', info.stageStart, 2200);
info = L.stageInfo(2200);
eq('progress: Civilization is maxed (orange bar)', info.isMax, true);
eq('progress: Civilization has no next threshold at 2200 either', info.nextXp, null);
info = L.stageInfo(2199);
eq('progress: Life is not maxed yet', info.isMax, false);
eq('progress: isMaxed helper agrees at 2200', L.isMaxed(2200), true);
eq('progress: isMaxed helper agrees at 2199', L.isMaxed(2199), false);
info = L.stageInfo(0);
eq('progress: 0 xp next threshold is 100', info.nextXp, 100);

// --- 5. XP accumulation through stages --------------------------------------
let st = freshWithPlanet(42);
let res = L.applyXp(st, 50, seedSeq());
eq('xp: 50 chars stays Dust cloud', res.stageIdx, 0);
eq('xp: no stage change at 50', res.stageChanged, false);
eq('xp: never rebirths at 50', res.rebirthed, false);
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

// --- 6. No automatic rebirth (cut Nov 12) ---------------------------------
// A maxed planet keeps gaining XP indefinitely — crossing 3600 (or
// any total) archives nothing and hatches nothing.
st = freshWithPlanet(42);
L.applyXp(st, 3550, seedSeq());
eq('no-rebirth: 3550 is Civilization (final)', L.stageForXp(st.current.xp), 6);
const oldSeed = st.current.seed;
res = L.applyXp(st, 100, seedSeq(5000));
eq('no-rebirth: crossed 3600 -> still no rebirth', res.rebirthed, false);
eq('no-rebirth: nothing archived past 3600', st.past.length, 0);
eq('no-rebirth: same planet keeps its seed', st.current.seed, oldSeed);
eq('no-rebirth: generation still 1', st.generation, 1);
eq('no-rebirth: XP keeps accumulating (3650)', st.current.xp, 3650);
eq('no-rebirth: chars keep accumulating', st.current.chars, 3650);

// A giant paste doesn't hatch anything either.
st = freshWithPlanet(42);
res = L.applyXp(st, 7300, seedSeq(9000));
eq('no-rebirth x2: 7300 chars -> still one planet', st.past.length, 0);
eq('no-rebirth x2: generation still 1', st.generation, 1);
eq('no-rebirth x2: XP is the full 7300', st.current.xp, 7300);
eq('no-rebirth x2: rebirthed flag unset', res.rebirthed, false);

// Exactly at the old boundary: nothing happens.
st = freshWithPlanet(42);
res = L.applyXp(st, 3600, seedSeq());
eq('no-rebirth: exactly 3600 does not rebirth', res.rebirthed, false);
eq('no-rebirth: exactly 3600 keeps 3600 XP', st.current.xp, 3600);

// becameMax fires exactly once, on the transition into Civilization.
st = freshWithPlanet(42);
res = L.applyXp(st, 2199, seedSeq());
eq('maxed: 2199 does not max yet', res.becameMax, false);
res = L.applyXp(st, 1, seedSeq());
eq('maxed: crossing 2200 fires becameMax once', res.becameMax, true);
eq('maxed: now Civilization', res.stageIdx, 6);
res = L.applyXp(st, 500, seedSeq());
eq('maxed: further typing does not re-fire becameMax', res.becameMax, false);
res = L.applyXp(st, 1000, seedSeq());
eq('maxed: past Civilization still no re-fire', res.becameMax, false);
eq('maxed: XP keeps growing past Civilization', st.current.xp, 3700);

// --- 7. Starter pick guarantees the terrain (Devon, Nov 11) ------------------
let icy = 0;
for (let seed = 1; seed <= 200; seed++) {
  if (Planet.generatePlanet(seed, 'icy').terrain === 'icy') icy++;
}
check('starter: pick guarantees the terrain (200/200 icy)', icy === 200, icy + '/200 icy');
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
// The pet lives in the Explorer (Devon, Nov 11) — a collapsible section,
// not its own Activity Bar icon. No viewsContainers.activitybar at all.
check('pkg: no activity bar container',
  !(pkg.contributes && pkg.contributes.viewsContainers && pkg.contributes.viewsContainers.activitybar));
const views = (pkg.contributes && pkg.contributes.views && pkg.contributes.views.explorer) || [];
check('pkg: pet view lives in the Explorer', views.some((v) => v.id === 'protoplanet.petView' && v.type === 'webview'));
const cmds = (pkg.contributes && pkg.contributes.commands) || [];
check('pkg: showPet command', cmds.some((c) => c.command === 'protoplanet.showPet'));
check('pkg: newPlanet command', cmds.some((c) => c.command === 'protoplanet.newPlanet'));
check('pkg: feedMineral command', cmds.some((c) => c.command === 'protoplanet.feedMineral'));
check('pkg: salvagePlanet command', cmds.some((c) => c.command === 'protoplanet.salvagePlanet'));
check('pkg: prestige command', cmds.some((c) => c.command === 'protoplanet.prestige'));
check('pkg: no activity bar icon reference', !JSON.stringify(pkg.contributes).includes('media/planet.svg'));
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
check('ext: uses petLogic for XP', extSrc.includes('Logic.applyXp'));
// The maxed-planet prompt is the ONE popup that can fire while
// typing (Nov 12): it fires once, when the planet first reaches
// Civilization, and only offers a new planet. The only other info
// message is a direct answer to a command the player just ran (Share
// with no planet yet) — never a typing interruption. The save
// confirmation lives in the panel itself (the Download button flashes
// "Saved!"), not a popup.
const infoPopups = (extSrc.match(/showInformationMessage/g) || []).length;
check('ext: typing pops up only the once-per-planet maxed prompt',
  infoPopups === 2 // maxed prompt + Share-with-no-planet guard
  && extSrc.includes('becameMax') && extSrc.includes('fully evolved')
  && extSrc.includes('No planet yet — pick a starter first, then share it.'));
check('ext: the save confirmation is in-panel, not a popup',
  extSrc.includes("type: 'saved'") && extSrc.includes("Saved!'"));
// Maxed (Civilization+) wiring: orange XP bar, isMax in the view
// model, MAX in the status bar, no next threshold past Civilization.
check('ext: XP bar turns orange at max (maxed class)', extSrc.includes('#xpfill.maxed') && extSrc.includes('#ff8c1a'));
check('ext: view model carries isMax', extSrc.includes('isMax: info.isMax'));
check('ext: status bar shows MAX at max', extSrc.includes('· MAX'));
check('ext: sidebar handles a null next threshold at max', extSrc.includes('msg.nextXp === null'));
// The sidebar webview runs planet.js as window.Protoplanet only — a bare
// `Planet` global does not exist there. (Nov 11: layout() threw
// ReferenceError: Planet is not defined at load, so 'ready' never fired
// and the pet art never rendered — placeholder text + black strip.)
// The webview script must use the P alias throughout.
check('ext: sidebar webview never uses a bare Planet global', !extSrc.includes('Planet.CONFIG.W'));
check('ext: sidebar webview uses the Protoplanet alias', extSrc.includes('P.CONFIG.W'));
// The two locked-ring labels sit above adjacent ring tops, which are
// only (spacing * TILT) apart — under one label height when many rings
// exist. The second label is staggered 26px higher so they can never
// collide (Devon, Nov 11: Ring 5 / Ring 6 overlapped).
check('ext: lock labels stagger so they never overlap', extSrc.includes('lockSeen * 26'));

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
// Helper: grow `n` finished planets — each one typed to Civilization
// (2500 chars) and then archived with a manual new planet (no
// auto-rebirth since Nov 12).
function growFinished(st, n, seedStart) {
  const seq = seedSeq(seedStart === undefined ? 10000 : seedStart);
  for (let i = 0; i < n; i++) { L.applyXp(st, 2500, seq); L.newPlanet(st, seq); }
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
// survives it moving into the archive (manual new planet).
st = freshWithPlanet(42);
pl = L.placePlanet(st, 0, st.current.seed, st.generation);
eq('place: current planet can be placed', pl.ok, true);
L.newPlanet(st, seedSeq(20000));
eq('place: slot survives the new planet (same seed+generation)',
  L.slotIndexForPlanet(st, 42, 1), 0);
eq('place: the old planet is now archived', st.past.some((p) => p.seed === 42), true);

// 13c. Names on records: stored at birth, derived for old records.
st = freshWithPlanet(42);
eq('name: current planet has its seed name',
  st.current.name, Planet.generatePlanetName(42));
L.newPlanet(st, seedSeq(21000));
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
L.newPlanet(st, seedSeq(22000));
eq('overflow: a new planet archives with a full system', st.past.length, beforePast + 1);
eq('overflow: a new planet hatches', st.current.xp, 0);
eq('overflow: the 5 rings are untouched by the new planet',
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
check('names: 31 planets grown through new planets are all distinct',
  new Set(allNames).size === allNames.length, new Set(allNames).size + ' distinct of ' + allNames.length);

// 13i. Display fixes (Nov 11 — Devon's preview feedback).
// (a) The panel shows a stage CAPPED at Civilization. End was cut
// Nov 12, so Civilization is the final stage and the cap is now a
// no-op safeguard — display stage always equals the true stage.
check('display stage: 3600 chars displays as Civilization', L.displayStageForXp(3600) === 6);
check('display stage: 3000 chars displays as Civilization', L.displayStageForXp(3000) === 6);
check('display stage: 2999 chars displays as Civilization', L.displayStageForXp(2999) === 6);
check('display stage: 2200 chars displays as Civilization', L.displayStageForXp(2200) === 6);
check('display stage: 1500 chars displays as Life', L.displayStageForXp(1500) === 5);
check('display stage: true stage is Civilization at 3600 too', L.stageForXp(3600) === 6);
// (b) The panel wires the cap, the bigger detailed star, the small
// discs again, the full-detail panel art, and the labeled card badges.
check('ext: panel caps the display stage', extSrc.includes('displayStageForXp'));
check('ext: orrery is a little more tilted (TILT 0.34)',
  extSrc.includes('TILT = 0.34') && !extSrc.includes('TILT = 0.42'));
check('ext: sun has no separate bright core disc (core blends with the granulation)',
  !extSrc.includes('d2 < 0.25'));
check('ext: sun shading is a graded warm ramp (smooth granulation, small steps)',
  extSrc.includes('Granulation') && extSrc.includes("['+', 214]")
  && extSrc.includes('smoothGn'));
check('ext: star has no stamped white-rectangle core',
  !extSrc.includes("['@', 231]"));
check('ext: sun renders finer (84x42 grid, smaller cells, same display size)',
  extSrc.includes('var W = 84, H = 42') && extSrc.includes('P.gridToHtml(grid, 3.67, 6.6)'));
check('ext: sun granulation churns over time (sec-dependent)',
  extSrc.includes('function starHtml(sec)') && extSrc.includes('Math.sin(sec * 0.9'));
check('ext: sun has solar flares',
  extSrc.includes('FLARES') && extSrc.includes('Solar flares'));
check('ext: sun is bright (lifted floor + gamma lift, 229 peaks, no white core)',
  extSrc.includes('0.30 + 0.70 * gn') && extSrc.includes('Math.pow(g * l * r * edge')
  && extSrc.includes("['@', 229]") && !extSrc.includes('d2 < 0.25'));
check('ext: sun reads 3D (strong limb darkening + rim fade)',
  extSrc.includes('0.50 + 0.50 * sz') && extSrc.includes('d2rel > 0.8'));
check('ext: sun peaks are stable (churn phase decoupled from granule value)',
  extSrc.includes('var ph = smoothGn'));
check('ext: big flares are rare (long periods, ~2.2s eruptions)',
  extSrc.includes('period: 47') && extSrc.includes('period: 63') && extSrc.includes('period: 89')
  && extSrc.includes('FLARE_DUR = 2.2')
  && !extSrc.includes('period: 13') && !extSrc.includes('period: 7') && !extSrc.includes('period: 11'));
check('ext: limb flames fizzle on their own fast phase (not the old slow halo wink)',
  extSrc.includes('LIMB FLAMES') && extSrc.includes('Math.sin(sec * 3.1'));
// Limb flames fizzle (Devon, Nov 11 — the fringe was frozen in every
// clip: measured only 17% of halo cells ever changed, 1.4% per tick).
// Run the real starHtml and measure the fringe band (d2rel in 1..1.3,
// i.e. just outside the DISC EDGE) directly: a visible share must
// change within a second, while the look stays the same (same lit
// count, '.'-dominant). The band is measured against the moving edge
// (d2rel with the real edgeRadius), not the fixed geometric radius —
// flame-tongue disc cells would otherwise pollute the band.
(function () {
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec) {'), extSrc.indexOf('// --- orrery'));
  const starHtml = new Function('P', starSrc + '\nreturn starHtml;')({
    noise2: Planet.noise2,
    gridToHtml: (grid) => grid,
  });
  const W = 84, H = 42;
  const flStart = starSrc.indexOf('var FLAMES = [');
  const edgeSrc = starSrc.slice(flStart, starSrc.indexOf('for (var y = 0; y < H; y++) {', flStart));
  const edgeRadiusFor = (sec) => new Function('sec', edgeSrc + '\nreturn edgeRadius;')(sec);
  const e0 = edgeRadiusFor(0), e1 = edgeRadiusFor(1);
  function band(x, y, edgeRadius) {
    const sx = (x - 42) / 21, sy = (y - 21) / 21;
    const d2 = sx * sx + (2 * sy) * (2 * sy);
    const th = Math.atan2(2 * sy, sx);
    const d2rel = d2 / Math.pow(edgeRadius(th), 2);
    return d2rel <= 1 ? 'disc' : (d2rel <= 1.3 ? 'halo' : 'out');
  }
  const g0 = starHtml(0), g1 = starHtml(1);
  let haloN = 0, haloChanged = 0, haloLit = 0, haloDots = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (band(x, y, e0) !== 'halo' && band(x, y, e1) !== 'halo') continue;
    haloN++;
    const a = g0[y][x], b = g1[y][x];
    if (a[0] !== ' ') { haloLit++; if (a[0] === '.') haloDots++; }
    if (a[0] !== b[0] || a[1] !== b[1]) haloChanged++;
  }
  check('limb flames fizzle: a visible share of the fringe changes in 1s',
    haloChanged / haloN > 0.10, haloChanged + ' of ' + haloN + ' fringe cells changed in 1s');
  check('limb flames keep the old look: about as many lit as before (~49)',
    haloLit >= 35 && haloLit <= 65, haloLit + ' lit at sec=0');
  check('limb flames are mostly dots (same style, "."-dominant)',
    haloLit > 0 && haloDots / haloLit > 0.6, haloDots + ' of ' + haloLit + ' lit fringe cells are dots');
})();
// The sun's SILHOUETTE flames (Devon, Nov 11 — batch #7 + the
// varied-flames refinement): the disc's silhouette bumps (left,
// top-left, bottom-left, bottom, right) never moved in any clip —
// batches #4/#5/#6 measured the wrong thing (fringe specks, a
// +/-1-cell wobble, fringe-tongue angles) and the clips were rendered
// from a stale copy of the page. The old lit-angle Jaccard on the
// fringe is NOT the right metric. Run the real starHtml and measure
// the SOLID mass edge (visible cells with >= 2 visible neighbours —
// isolated specks don't count): tall flames (>= 3 cells past the
// base disc) must stick out at sec=2, be at different places a few
// seconds later, and vary in shape (taller/shorter, wider/narrower),
// not one bump shape stamped around the rim.
(function () {
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec) {'), extSrc.indexOf('// --- orrery'));
  const starHtml = new Function('P', starSrc + '\nreturn starHtml;')({
    noise2: Planet.noise2,
    gridToHtml: (grid) => grid,
  });
  const W = 84, H = 42;
  function isMassCell(grid, x, y) {
    const c = grid[y][x];
    if (c[0] === ' ' || c[1] < 208) return false;
    let n = 0;
    if (y > 0 && grid[y - 1][x][0] !== ' ' && grid[y - 1][x][1] >= 208) n++;
    if (y < H - 1 && grid[y + 1][x][0] !== ' ' && grid[y + 1][x][1] >= 208) n++;
    if (x > 0 && grid[y][x - 1][0] !== ' ' && grid[y][x - 1][1] >= 208) n++;
    if (x < W - 1 && grid[y][x + 1][0] !== ' ' && grid[y][x + 1][1] >= 208) n++;
    return n >= 2;
  }
  function massExtent(grid, deg) {
    const th = deg * Math.PI / 180;
    let maxR = 0;
    for (let r = 0; r <= 1.4; r += 0.005) {
      const x = Math.round(42 + 21 * r * Math.cos(th));
      const y = Math.round(21 + 10.5 * r * Math.sin(th));
      if (y < 0 || y >= H || x < 0 || x >= W) continue;
      if (isMassCell(grid, x, y)) maxR = r;
    }
    return maxR;
  }
  function smoothProfile(sec) {
    const g = starHtml(sec);
    const raw = [];
    for (let deg = 0; deg < 360; deg += 5) raw.push(massExtent(g, deg));
    const n = raw.length;
    return raw.map((_, i) => (raw[(i - 1 + n) % n] + raw[i] + raw[(i + 1) % n]) / 3);
  }
  function flameSegments(ext) {
    const segs = [];
    let cur = null;
    for (let i = 0; i <= ext.length; i++) {
      const e = i < ext.length ? ext[i] : 0;
      if (e > 1.03) {
        if (!cur) cur = { start: i * 5, bins: 0, maxE: 0 };
        cur.bins++;
        cur.maxE = Math.max(cur.maxE, e);
      } else if (cur) { segs.push(cur); cur = null; }
    }
    return segs.map((s) => ({
      at: Math.round(s.start + (s.bins * 5) / 2),
      hCells: (s.maxE - 1) * 21,
      wDeg: s.bins * 5,
    }));
  }
  const f2 = flameSegments(smoothProfile(2));
  const f6 = flameSegments(smoothProfile(6));
  const tall2 = f2.filter((f) => f.hCells >= 3);
  const tall6 = f6.filter((f) => f.hCells >= 3);
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const tallest2 = f2.reduce((m, f) => (f.hCells > m.hCells ? f : m), { hCells: 0, at: 0 });
  const tallest6 = f6.reduce((m, f) => (f.hCells > m.hCells ? f : m), { hCells: 0, at: 0 });
  check('sun silhouette flames: tall flames (>=3 cells) stick out at sec=2',
    tall2.length >= 2, tall2.length + ' tall flames at sec=2: ' + JSON.stringify(tall2.map((f) => f.at + 'deg/' + f.hCells.toFixed(1) + 'c')));
  check('sun silhouette flames: the tall flames are at different places a few seconds later',
    !tall6.some((f) => tall2.some((t) => angDiff(f.at, t.at) <= 20)) &&
    (Math.abs(tallest2.hCells - tallest6.hCells) >= 2 || angDiff(tallest2.at, tallest6.at) > 20),
    'tallest sec=2: ' + tallest2.at + 'deg/' + tallest2.hCells.toFixed(1) + 'c | tallest sec=6: ' + tallest6.at + 'deg/' + tallest6.hCells.toFixed(1) + 'c');
  const heights = f2.map((f) => f.hCells);
  const widths = [...new Set(f2.map((f) => f.wDeg))];
  check('sun silhouette flames vary in shape (taller/shorter, wider/narrower — not one repeated bump)',
    heights.length >= 3 && Math.max(...heights) - Math.min(...heights) >= 3 && widths.length >= 3,
    'sec=2 flame heights ' + heights.map((h) => h.toFixed(1)).join(',') + ' cells | widths ' + widths.join(',') + ' deg');
  const A = smoothProfile(2), B = smoothProfile(6);
  let maxMove = 0;
  for (let i = 0; i < A.length; i++) maxMove = Math.max(maxMove, Math.abs(B[i] - A[i]) * 21);
  check('sun silhouette moves: the outline shifts by several cells between sec=2 and sec=6',
    maxMove >= 4, 'max outline move ' + maxMove.toFixed(1) + ' cells');
})();
check('ext: sun edge carries flames (tongues grow/die at different angles, not a frozen ellipse)',
  extSrc.includes('FLAMES') && extSrc.includes('function edgeRadius(th)') && extSrc.includes('d2rel')
  && extSrc.includes('Math.pow(Math.sin(Math.PI * u), 1.5)'));
// The sun's EDGE moves (Devon, Nov 11 — the little points sticking out
// around the outline were completely still; the silhouette never
// changed. Batch #4's fizzling halo specks were the wrong thing — the
// disc boundary itself was a frozen ellipse: measured 0.0% of disc
// cells ever changing blank/lit state, and the lit radius at 90deg
// stuck at 0.99 for all 14s). Run the real starHtml: the outline band
// must flip lit/blank as the edge passes over it, while the disc
// interior stays solid.
(function () {
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec) {'), extSrc.indexOf('// --- orrery'));
  const starHtml = new Function('P', starSrc + '\nreturn starHtml;')({
    noise2: Planet.noise2,
    gridToHtml: (grid) => grid,
  });
  const W = 84, H = 42;
  function rad(x, y) {
    const sx = (x - 42) / 21, sy = (y - 21) / 21;
    return Math.sqrt(sx * sx + (2 * sy) * (2 * sy));
  }
  const secs = [];
  for (let s = 0; s <= 14.001; s += 0.5) secs.push(+s.toFixed(2));
  const grids = secs.map((s) => starHtml(s));
  const isLit = (c) => c[0] !== ' ';
  let edgeN = 0, edgeEverChanged = 0, discEverChanged = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = rad(x, y);
    const litStates = grids.map((g) => isLit(g[y][x]));
    const changed = new Set(litStates).size > 1;
    if (r <= 0.90) { if (changed) discEverChanged++; }
    else if (r <= 1.15) { edgeN++; if (changed) edgeEverChanged++; }
  }
  // Silhouette extent straight down (90deg) — frozen at 0.99 before.
  function maxLitRadiusDown(grid) {
    let maxR = 0;
    for (let r = 0; r <= 1.35; r += 0.01) {
      const y = Math.round(21 + 10.5 * r);
      if (y >= 0 && y < H && isLit(grid[y][42])) maxR = r;
    }
    return maxR;
  }
  const ext0 = maxLitRadiusDown(grids[0]);
  const extMax = Math.max(...grids.map(maxLitRadiusDown));
  check('sun edge moves: a visible share of the outline band flips lit/blank over 14s',
    edgeEverChanged / edgeN > 0.30, edgeEverChanged + ' of ' + edgeN + ' outline cells flipped');
  check('sun edge moves: the disc interior stays solid (only the outline wobbles)',
    discEverChanged === 0, discEverChanged + ' interior cells flipped');
  check('sun edge moves: the silhouette extent drifts (was frozen at 0.99 straight down)',
    extMax - ext0 > 0.03, 'extent ' + ext0.toFixed(2) + ' -> ' + extMax.toFixed(2));
})();
check('ext: sun re-renders on the tick (never frozen)',
  extSrc.includes('renderStar()') && extSrc.includes('tick % 2 === 0'));
// Sidebar (Devon, Nov 11): trimmed to the stage line, the grown-from
// line, and the XP bar. No flavor description, no world details —
// those live in the detail panel / Pokedex, which still shows them.
check('sidebar: no flavor description after hatching',
  !extSrc.includes('textContent = msg.stageDesc'));
check('sidebar: meta is only the grown-from line',
  extSrc.includes("'Grown from ' + msg.chars + ' characters'")
  && !extSrc.includes('msg.summary'));
check('sidebar: XP bar has a visible track and a numbers label',
  extSrc.includes('#xplabel') && extSrc.includes("getElementById('xplabel')"));
check('ext: orrery discs are small again (46x24 cozy, not 68x38)',
  extSrc.includes('P.renderCozy(d.planet.planet, d.planet.stageIdx, 10, sec, 1.0, 46, 24, undefined, 0.5), 2.6, 6.12')
  && !extSrc.includes('68, 38), 3.4, 6.12'));
check('ext: detail panel uses the full render, not the cozy downsample',
  extSrc.includes('P.render(planet.planet, planet.stageIdx, 10, sec, 1.2, undefined, 0.5), 2.35, 4.23'));
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

// 13l. Batch #9 (Devon, Nov 11, 11:36 PM — queued notes, fixed Nov 12):
// (1) plain scroll scrolls the page to the Archive instead of
// zooming; (2) hovering a ring highlights the ring itself, no
// separate gold ring drawn above it; (3) no 'Sol' label under the
// sun; (4) no standing-still stars around the sun; (5) Shattered
// birth smoke stays close to the core in the solar-system renders.
// (1) Wheel gating: the handler returns before preventDefault on a
// plain wheel, so the page scrolls; only Ctrl/Cmd+scroll zooms.
(function () {
  const wheelSrc = extSrc.slice(extSrc.indexOf("addEventListener('wheel'"), extSrc.indexOf("addEventListener('wheel'") + 600);
  check('ext: plain wheel does not zoom (returns before preventDefault)',
    wheelSrc.indexOf('if (!e.ctrlKey && !e.metaKey) return;') !== -1
    && wheelSrc.indexOf('if (!e.ctrlKey && !e.metaKey) return;') < wheelSrc.indexOf('e.preventDefault()'),
    wheelSrc.slice(0, 220));
  check('ext: ctrl/cmd+wheel still zooms',
    wheelSrc.includes('zoom = Math.max(0.3, Math.min(3, zoom * Math.exp(-e.deltaY * 0.001)))'));
  check('ext: zoom hint names Ctrl+Scroll', extSrc.includes('Ctrl+Scroll to zoom'));
})();
// (2) Ring hover highlights the ring itself.
check('ext: no separate gold ring drawn above a hovered ring',
  !extSrc.includes('.ringHit:hover'));
check('ext: hovered ring brightens and thickens itself (.ring.hot)',
  extSrc.includes('.ring.hot { border-color: rgba(232, 182, 76, 0.95); border-width: 2px; }'));
check('ext: ring hover is driven by mouseover/mouseout on the hit areas',
  extSrc.includes("worldEl.addEventListener('mouseover'") && extSrc.includes('setRingHot('));
// (3) No 'Sol' text under the sun.
check('ext: no Sol label under the sun',
  !extSrc.includes('starName') && !extSrc.includes("'Sol'"));
// (4) No standing-still stars stamped around the sun: the six fixed
// speck assignments are gone from starHtml.
(function () {
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec) {'), extSrc.indexOf('// --- orrery'));
  const specks = ['grid[4][12]', 'grid[6][73]', 'grid[36][10]', 'grid[37][75]', 'grid[3][58]', 'grid[39][30]'];
  check('ext: no fixed star specks stamped around the sun',
    specks.every((s) => !starSrc.includes(s)),
    specks.filter((s) => starSrc.includes(s)).join(', ') || 'none remain');
})();
// (5) Shattered-birth smoke stays close to the core in the solar
// system (smokeScale 0.5): plume tips reach ~1.3x radius, not ~2.0x,
// so the haze no longer fills the whole frame. Measured on the real
// smokeCellAt, along each plume's axis over 4 seconds.
(function () {
  const seed = 12345, r = 18, CX = 68, CY = 38;
  const smoke = Planet.buildSmoke(seed);
  function cellAt(radN, ang, sec, scale) {
    const x = Math.round(CX + radN * r * Math.cos(ang));
    const y = Math.round(CY + (radN * r * Math.sin(ang)) / 2);
    return Planet.smokeCellAt(x, y, r, radN, smoke, sec, seed, null, scale);
  }
  let farFull = 0, farHalf = 0, nearHalf = 0;
  for (const p of smoke) {
    for (let sec = 0; sec <= 4; sec += 0.05) {
      if (cellAt(1.6, p.ang, sec, 1.0)) farFull++;
      if (cellAt(1.6, p.ang, sec, 0.5)) farHalf++;
      if (cellAt(1.2, p.ang, sec, 0.5)) nearHalf++;
    }
  }
  check('smoke: at full scale the haze reaches 1.6x radius (the old look)',
    farFull > 0, farFull + ' hits at radN 1.6, scale 1.0');
  check('smoke: at the solar-system scale nothing reaches 1.6x radius',
    farHalf === 0, farHalf + ' hits at radN 1.6, scale 0.5');
  check('smoke: the haze still exists close in at the solar-system scale',
    nearHalf > 0, nearHalf + ' hits at radN 1.2, scale 0.5');
  check('ext: solar-system renders pass the reduced smoke scale (orrery, detail, archive, tick)',
    extSrc.includes('P.renderCozy(d.planet.planet, d.planet.stageIdx, 10, sec, 1.0, 46, 24, undefined, 0.5)')
    && extSrc.includes('P.render(planet.planet, planet.stageIdx, 10, sec, 1.2, undefined, 0.5)')
    && extSrc.includes('P.renderCozy(p.planet, p.stageIdx, 10, 5, 1.0, 34, 19, undefined, 0.5)'));
  check('ext: sidebar pet and prestige renders keep the full smoke (default scale)',
    extSrc.includes('P.render(state.planet, state.stageIdx, t, sec), cellW, cellH)')
    && extSrc.includes('P.renderCozy(p.planet, p.stageIdx, 10, 5, 1.0, 34, 19), 3.4, 6.12)'));
})();

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

// --- 15. Share card (P0, Nov 12 — Devon picked it first) ------------------
// The filename and the README markdown are pure petLogic helpers, so
// the panel and the tests agree on exactly what gets shared. A seed
// hatches the exact same planet, so the seed is the shareable planet.
const sharePlanet = {
  name: 'K2-277c', seed: 805839337, stageName: 'Civilization',
  mutationLabel: 'MUTATION · Green Moon', generation: 5, chars: 2400,
  terrainLabel: 'Toxic world',
};
eq('share: filename slugifies the catalog name',
  L.shareCardFilename('K2-277c', 5), 'protoplanet-k2-277c-gen5.png');
eq('share: filename strips spaces and dots',
  L.shareCardFilename('TOI 700.d', 2), 'protoplanet-toi-700-d-gen2.png');
eq('share: filename falls back for an empty name',
  L.shareCardFilename('', 1), 'protoplanet-planet-gen1.png');
eq('share: filename defaults the generation to 1',
  L.shareCardFilename('Kepler-442b'), 'protoplanet-kepler-442b-gen1.png');
const shareMd = L.shareCardMarkdown(sharePlanet, 'protoplanet-k2-277c-gen5.png');
check('share: markdown embeds the PNG file',
  shareMd.includes('![K2-277c — Protoplanet](protoplanet-k2-277c-gen5.png)'), shareMd);
check('share: markdown names the planet, terrain, stage, generation and chars',
  shareMd.includes('**K2-277c** · Toxic world · Civilization · Gen 5 · grown from 2,400 characters'), shareMd);
check('share: markdown carries the mutation label when the planet has one',
  shareMd.includes('MUTATION · Green Moon'), shareMd);
check('share: markdown embeds the seed in backticks',
  shareMd.includes('Seed `805839337`'), shareMd);
check('share: markdown links the Protoplanet repo',
  shareMd.includes('[Protoplanet](https://github.com/devoncline/protoplanet)'), shareMd);
// A plain planet (no mutation) gets a clean card — no mutation line.
const plainMd = L.shareCardMarkdown({ ...sharePlanet, mutationLabel: null }, 'protoplanet-k2-277c-gen5.png');
check('share: markdown has no mutation line for a plain planet',
  !plainMd.includes('MUTATION'), plainMd);
check('share: plain card still embeds the seed',
  plainMd.includes('Seed `805839337`'), plainMd);

// 15b. package.json + extension.js wiring for the Share panel.
check('pkg: sharePlanet command', cmds.some((c) => c.command === 'protoplanet.sharePlanet'));
check('ext: registers sharePlanet', extSrc.includes("'protoplanet.sharePlanet'"));
check('ext: share panel HTML exists', extSrc.includes('getShareHtml'));
check('ext: share panel is a dedicated webview panel', extSrc.includes("'protoplanet.share'"));
check('ext: share builds its view model from the shared renderable helper', extSrc.includes('shareViewModel') && extSrc.includes('renderablePlanet'));
check('ext: share filename comes from petLogic', extSrc.includes('Logic.shareCardFilename'));
check('ext: share markdown comes from petLogic', extSrc.includes('Logic.shareCardMarkdown'));
check('ext: share handles the download message', extSrc.includes("msg.type === 'downloadPng'"));
check('ext: share asks where to save (save dialog)', extSrc.includes('showSaveDialog'));
check('ext: share writes the PNG bytes to disk', extSrc.includes('workspace.fs.writeFile'));
check('ext: share copies the seed through the host clipboard', extSrc.includes("msg.type === 'copySeed'") && extSrc.includes('env.clipboard.writeText'));
check('ext: share copies the markdown through the host clipboard', extSrc.includes("msg.type === 'copyMarkdown'"));
check('ext: share panel draws the PNG on a canvas', extSrc.includes('pngCanvas') && extSrc.includes('toBlob'));
check('ext: share canvas uses the full-density render (same grid as the panel)', extSrc.includes('P.render(state.planet, state.stageIdx,') && extSrc.includes('P.CONFIG.W, P.CONFIG.H)'));
check('ext: share canvas colors cells from the ANSI palette', extSrc.includes('P.ansi256ToRgb'));
check('ext: share panel shows the seed', extSrc.includes('id="seedText"'));
check('ext: share panel shows the README block', extSrc.includes('id="markdownBlock"'));
check('ext: share panel has all three actions', extSrc.includes('id="downloadPngBtn"') && extSrc.includes('id="copySeedBtn"') && extSrc.includes('id="copyMarkdownBtn"'));
check('ext: share panel reuses the fixed-cell renderer', extSrc.includes('gridToHtml'));
check('ext: share panel pushes live state on typing', extSrc.includes('postShareState'));

// --- 16. Seed hatch (Nov 12) ------------------------------------------------
// A seed hatches the same base planet, mutations stripped — the
// original keeps its mutations in the collection.

// parseSeedInput: accepts plain integers in range, rejects the rest.
eq('seed input: plain seed', L.parseSeedInput('805839337').ok, true);
eq('seed input: plain seed value', L.parseSeedInput('805839337').seed, 805839337);
eq('seed input: zero', L.parseSeedInput('0').seed, 0);
eq('seed input: max', L.parseSeedInput('999999999').seed, 999999999);
eq('seed input: trims spaces', L.parseSeedInput('  42  ').seed, 42);
eq('seed input: leading zeros', L.parseSeedInput('007').seed, 7);
check('seed input: empty rejected', L.parseSeedInput('').ok === false);
check('seed input: spaces only rejected', L.parseSeedInput('   ').ok === false);
check('seed input: letters rejected', L.parseSeedInput('abc').ok === false);
check('seed input: mixed rejected', L.parseSeedInput('12a').ok === false);
check('seed input: negative rejected', L.parseSeedInput('-5').ok === false);
check('seed input: decimal rejected', L.parseSeedInput('1.5').ok === false);
check('seed input: too big rejected', L.parseSeedInput('1000000000').ok === false);
check('seed input: null rejected', L.parseSeedInput(null).ok === false);

// makeSeedPlanet: the canonical roll for the seed, mutations stripped.
{
  let mutSeed = null, mutPlanet = null;
  for (let s = 0; s < 4000 && !mutSeed; s++) {
    const pl = Planet.generatePlanet(s);
    if (pl.mutations.length > 0) { mutSeed = s; mutPlanet = pl; }
  }
  const hatched = L.makeSeedPlanet(mutSeed, new Set());
  check('seed planet: mutations stripped', hatched.mutations.length === 0, `seed ${mutSeed}, was ${mutPlanet.mutations.join(',')}`);
  check('seed planet: same terrain as the canonical roll', hatched.terrain === mutPlanet.terrain);
  check('seed planet: base ring, not the mutated ring', hatched.ringType === mutPlanet.baseRingType, `${mutPlanet.ringType} -> ${hatched.ringType}`);
  check('seed planet: same name as the canonical roll', hatched.name === mutPlanet.name);
  check('seed planet: same moons', hatched.moons.length === mutPlanet.moons.length);
  check('seed planet: same size', hatched.size === mutPlanet.size);
  check('seed planet: starts at 0 XP', hatched.xp === 0 && hatched.chars === 0);
  check('seed planet: not a parent, no lineage', hatched.usedAsParent === false && hatched.parents === null);
  check('seed planet: deterministic',
    JSON.stringify(L.makeSeedPlanet(mutSeed, new Set())) === JSON.stringify(hatched));
}

// hatchFromSeed: archives the current planet (mutations KEPT in the
// collection), hatches the seed's base planet, generation +1.
{
  let mutSeed = null;
  for (let s = 0; s < 4000 && !mutSeed; s++) {
    if (Planet.generatePlanet(s).mutations.length > 0) mutSeed = s;
  }
  const st = freshWithPlanet(mutSeed);
  const oldName = st.current.name;
  const oldMuts = st.current.mutations.slice();
  const p = L.hatchFromSeed(st, 805839337);
  check('seed hatch: current archived', st.past.length === 1 && st.past[0].seed === mutSeed);
  check('seed hatch: archived planet KEEPS its mutations', JSON.stringify(st.past[0].mutations) === JSON.stringify(oldMuts), oldMuts.join(','));
  check('seed hatch: generation +1', st.generation === 2);
  check('seed hatch: current is the seed planet', st.current === p && p.seed === 805839337);
  check('seed hatch: hatched planet has no mutations', p.mutations.length === 0);
  check('seed hatch: hatched planet is the canonical roll', p.terrain === Planet.generatePlanet(805839337).terrain && p.name === Planet.generatePlanet(805839337).name);
}
// A fed mineral is NOT consumed by a seed hatch — the hatch is the
// seed's canonical planet, not a roll — and it still applies to the
// next rolled birth (new planet).
{
  const st = freshWithPlanet(42);
  const fedId = st.minerals[0].id; // the starter mineral from startFirstPlanet
  L.feedMineral(st, fedId);
  L.hatchFromSeed(st, 805839337);
  check('seed hatch: fed mineral stays fed', st.fedMineral && st.fedMineral.id === fedId);
  check('seed hatch: inventory untouched', st.minerals.length === 0);
  L.newPlanet(st, () => 777);
  check('seed hatch: fed mineral consumed by the NEXT rolled birth', st.fedMineral === null);
}
// No current planet yet (first run): the seed hatch IS the first
// planet — starter done + the one free starter mineral, still Gen 1.
{
  const st = L.freshState();
  const p = L.hatchFromSeed(st, 805839337);
  check('seed hatch first run: planet hatched', !!st.current && st.current.seed === 805839337);
  check('seed hatch first run: still Gen 1', st.generation === 1);
  check('seed hatch first run: starter done', st.starterDone === true);
  check('seed hatch first run: starter mineral granted', st.minerals.length === 1);
  check('seed hatch first run: no archive', st.past.length === 0);
}
// Hatching from the current planet's own seed: the archived original
// keeps its name, the new planet's name nudges — same seed, new life.
{
  const st = freshWithPlanet(42);
  const oldName = st.current.name;
  const p = L.hatchFromSeed(st, 42);
  check('seed hatch: same-seed name nudged (old name taken)', p.name !== oldName, `${oldName} -> ${p.name}`);
  check('seed hatch: seed still the input seed', p.seed === 42);
  check('seed hatch: past keeps the original name', st.past.length === 1 && st.past[0].name === oldName);
}
// Wiring: package.json + extension.js.
check('pkg: hatchFromSeed command', cmds.some((c) => c.command === 'protoplanet.hatchFromSeed'));
check('ext: registers hatchFromSeed', extSrc.includes("'protoplanet.hatchFromSeed'"));
check('ext: hatchFromSeed asks for the seed', extSrc.includes('showInputBox') && extSrc.includes('hatchFromSeed'));
check('ext: hatchFromSeed validates with parseSeedInput', extSrc.includes('Logic.parseSeedInput'));
check('ext: hatchFromSeed calls Logic.hatchFromSeed', extSrc.includes('Logic.hatchFromSeed(this.state'));
check('ext: hatchFromSeed confirms with a modal warning', extSrc.includes('Yes, hatch it'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n- ' + failures.join('\n- '));
  process.exit(1);
}
