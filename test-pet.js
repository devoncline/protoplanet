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
eq('count: big paste earns nothing (round 11 — block big pastes only)', L.countInsertedChars([{ text: 'x'.repeat(500), rangeLength: 0 }]), 0);
eq('count: multi-line paste earns nothing', L.countInsertedChars([{ text: 'line1\nline2\nline3', rangeLength: 0 }]), 0);
eq('count: long single-line insert earns nothing', L.countInsertedChars([{ text: 'x'.repeat(51), rangeLength: 0 }]), 0);
eq('count: 50-char insert still counts', L.countInsertedChars([{ text: 'x'.repeat(50), rangeLength: 0 }]), 50);
eq('count: lone Enter counts 1', L.countInsertedChars([{ text: '\n', rangeLength: 0 }]), 1);
eq('count: autocomplete word counts', L.countInsertedChars([{ text: 'console', rangeLength: 0 }]), 7);

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

// --- 4b. Per-stage XP bar (round 6, Nov 12 — Devon) ------------------------
// The bar resets at every stage-up: it shows progress INSIDE the
// current stage plus that stage's goal, not the cumulative total.
// 292 XP is "192 / 200" (stage 1), 350 XP is "50 / 300" (stage 2).
// At Civilization there is no next stage: fill is full and the label
// is the MAX line with the total XP, unchanged.
function barEq(xp, inStage, span, label) {
  const b = L.xpBar(xp);
  eq(`xpbar: ${xp} xp in-stage`, b.inStage, inStage);
  eq(`xpbar: ${xp} xp span`, b.span, span);
  eq(`xpbar: ${xp} xp label`, b.label, label);
  check(`xpbar: ${xp} xp fill`, Math.abs(b.fill - (span === null ? 1 : inStage / span)) < 1e-12,
    'got ' + b.fill);
  eq(`xpbar: ${xp} xp maxed`, b.isMax, span === null);
}
barEq(0, 0, 100, 'XP 0 / 100');
barEq(50, 50, 100, 'XP 50 / 100');
barEq(99, 99, 100, 'XP 99 / 100');
barEq(100, 0, 200, 'XP 0 / 200');
barEq(150, 50, 200, 'XP 50 / 200');
barEq(292, 192, 200, 'XP 192 / 200');
barEq(300, 0, 300, 'XP 0 / 300');
barEq(350, 50, 300, 'XP 50 / 300');
barEq(599, 299, 300, 'XP 299 / 300');
barEq(600, 0, 400, 'XP 0 / 400');
barEq(999, 399, 400, 'XP 399 / 400');
barEq(1000, 0, 500, 'XP 0 / 500');
barEq(1499, 499, 500, 'XP 499 / 500');
barEq(1500, 0, 700, 'XP 0 / 700');
barEq(2199, 699, 700, 'XP 699 / 700');
barEq(2200, 0, null, 'XP 2200 · MAX — fully evolved');
barEq(2500, 300, null, 'XP 2500 · MAX — fully evolved');

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

// --- 6b. Notification texts (round 6, Nov 12 — Devon) ----------------------
// Plain, short toasts. Stage-up names the planet + the new stage;
// hatch names the planet; mutation names every mutation it was born
// with (one or two). A plain planet earns no mutation toast.
const notifPlanet = L.makePlanet((() => {
  for (let s = 0; s < 4000; s++) {
    if (Planet.generatePlanet(s).mutations.length === 0) return s;
  }
  return 42;
})());
const notifName = L.nameForPlanet(notifPlanet);
eq('notif: stage-up names planet + stage', L.stageUpMessage(notifPlanet, 2), `${notifName} reached Molten!`);
eq('notif: stage-up to Civilization', L.stageUpMessage(notifPlanet, 6), `${notifName} reached Civilization!`);
eq('notif: hatch names the planet', L.hatchMessage(notifPlanet), `${notifName} was born!`);
eq('notif: plain planet has no mutation message', L.mutationMessage(notifPlanet), null);
check('notif: plain planet earns only the birth toast',
  JSON.stringify(L.birthNotifications(notifPlanet)) === JSON.stringify([`${notifName} was born!`]),
  JSON.stringify(L.birthNotifications(notifPlanet)));
function singleMutationSeed() {
  for (let s = 0; s < 4000; s++) {
    if (Planet.generatePlanet(s).mutations.length === 1) return s;
  }
  return null;
}
function twoMutationSeed() {
  for (let s = 0; s < 4000; s++) {
    if (Planet.generatePlanet(s).mutations.length === 2) return s;
  }
  return null;
}
const oneSeed = singleMutationSeed();
check('notif: a single-mutation seed exists for the test', oneSeed !== null);
const oneMut = L.makePlanet(oneSeed);
const oneMutName = (Planet.mutationDef(oneMut.mutations[0]) || {}).name;
eq('notif: one mutation names it', L.mutationMessage(oneMut),
  `${L.nameForPlanet(oneMut)} was born with a mutation: ${oneMutName}!`);
check('notif: mutated planet earns hatch + mutation toasts',
  JSON.stringify(L.birthNotifications(oneMut)) === JSON.stringify([
    `${L.nameForPlanet(oneMut)} was born!`,
    `${L.nameForPlanet(oneMut)} was born with a mutation: ${oneMutName}!`,
  ]),
  JSON.stringify(L.birthNotifications(oneMut)));
const twoSeed = twoMutationSeed();
check('notif: a two-mutation seed exists for the test', twoSeed !== null);
const twoMut = L.makePlanet(twoSeed);
const twoMutNames = twoMut.mutations.map((id) => (Planet.mutationDef(id) || {}).name);
eq('notif: two mutations name both', L.mutationMessage(twoMut),
  `${L.nameForPlanet(twoMut)} was born with mutations: ${twoMutNames.join(' + ')}!`);

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
eq('new planet: ok', np.ok, true);
eq('new planet: returned planet is current', np.planet, st.current);

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
check('pkg: applyMineral command', cmds.some((c) => c.command === 'protoplanet.applyMineral'));
check('pkg: salvagePlanet command', cmds.some((c) => c.command === 'protoplanet.salvagePlanet'));
check('pkg: prestige command', cmds.some((c) => c.command === 'protoplanet.prestige'));
check('pkg: no activity bar icon reference', !JSON.stringify(pkg.contributes).includes('media/planet.svg'));
check('pkg: planet.js exists for the webview', fs.existsSync(path.join(__dirname, 'planet.js')));

const extSrc = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');
check('ext: registers showPet', extSrc.includes("'protoplanet.showPet'"));
check('ext: registers newPlanet', extSrc.includes("'protoplanet.newPlanet'"));
check('ext: registers applyMineral', extSrc.includes("'protoplanet.applyMineral'"));
check('ext: registers salvagePlanet', extSrc.includes("'protoplanet.salvagePlanet'"));
check('ext: registers prestige', extSrc.includes("'protoplanet.prestige'"));
check('ext: status bar shows minerals', extSrc.includes('mineralSummary'));
check('ext: listens for typing', extSrc.includes('onDidChangeTextDocument'));
check('ext: uses gridToHtml (fixed cells)', extSrc.includes('gridToHtml'));
check('ext: no bare <pre> grid rendering', !/\.grid.*innerHTML\s*=\s*[^P]/.test(extSrc) || extSrc.includes('gridToHtml'));
check('ext: webview uses nonce CSP', extSrc.includes('Content-Security-Policy') && extSrc.includes('nonce-'));
check('ext: uses petLogic for XP', extSrc.includes('Logic.applyXp'));
// Popups while typing (Nov 12 — round 6, Devon's call): the stage-up
// toast joins the once-per-planet maxed prompt — both are short toasts
// on a real event (a stage crossing, first reaching Civilization),
// never on ordinary typing. All toasts (stage-up, hatch, mutation,
// apply success/fizzle, set) funnel through ONE showInformationMessage
// call site — notify() — so the count stays small and no new popup
// can sneak in unnoticed. The only other info messages are direct
// answers to a command the player just ran (Share with no planet yet,
// Apply with no planet / no usable mineral / a blocked mineral) —
// never a typing interruption. The save confirmation lives in the
// panel itself (the Download button flashes "Saved!"), not a popup.
const infoPopups = (extSrc.match(/showInformationMessage/g) || []).length;
check('ext: typing pops up only stage-up toast + once-per-planet maxed prompt',
  infoPopups === 6 // notify() choke point + maxed prompt + Share-with-no-planet guard + Apply's three direct answers
  && extSrc.includes('becameMax') && extSrc.includes('fully evolved')
  && extSrc.includes('No planet yet — pick a starter first, then share it.')
  && extSrc.includes('notifyStageUp')
  && extSrc.includes('No planet is growing — hatch one first, then spend a mineral on it.'));
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

// --- 12. Minerals, mutate attempts, salvage/recycle, prestige (step 2) -
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
check('minerals: starter is your first mutate attempt (glow family)', L.mineralApplyText(st.minerals[0]).includes('glow'));
eq('minerals: second grant is a no-op', L.grantStarterMineral(st), null);
eq('minerals: still one after second grant', st.minerals.length, 1);

// 12b. The mutate attempt (round 10 — the mineral IS the mutation):
// spend a mineral on the planet you love, coin flip. Success adds
// the mutation (with its visuals); failure eats the mineral and
// nothing changes; a mineral the planet already has is blocked and
// NOT consumed. A family mineral tries a random mutation in its
// family that the planet doesn't already have.
{
  // Success: fixed rng 0.1 < 0.5 — the Green Moon lands.
  st = freshWithPlanet(42);
  st.current.mutations = [];
  const gm = L.makeMineral(st, { family: 'moon', mutation: 'green-moon', source: 'salvage' });
  st.minerals.push(gm);
  const before = st.minerals.length;
  const ok1 = L.attemptMutation(st, gm.id, () => 0.1);
  eq('apply: ok', ok1.ok, true);
  eq('apply: success', ok1.success, true);
  eq('apply: mutation id', ok1.mutationId, 'green-moon');
  eq('apply: mutation name', ok1.mutationName, 'Green Moon');
  eq('apply: mineral consumed', st.minerals.length, before - 1);
  check('apply: planet now carries it', st.current.mutations.includes('green-moon'));
  check('apply: discovery recorded', st.discovered.includes('green-moon'));
  check('apply: the moon actually turns green (visuals baked)',
    st.current.moons.some((m) => m.tint === 46 && (m.mutantIds || []).includes('green-moon')));
  // Failure: fixed rng 0.9 >= 0.5 — the mineral is gone, the planet unchanged.
  st = freshWithPlanet(42);
  st.current.mutations = [];
  const gm2 = L.makeMineral(st, { family: 'moon', mutation: 'green-moon', source: 'salvage' });
  st.minerals.push(gm2);
  const ok2 = L.attemptMutation(st, gm2.id, () => 0.9);
  eq('apply: fizzle still ok', ok2.ok, true);
  eq('apply: fizzle is not a success', ok2.success, false);
  eq('apply: fizzle eats the mineral', st.minerals.some((m) => m.id === gm2.id), false);
  check('apply: fizzle leaves the planet plain', !st.current.mutations.includes('green-moon'));
  check('apply: fizzle is not discovered', !st.discovered.includes('green-moon'));
  // Blocked: the planet already has it — the mineral is NOT consumed.
  st = freshWithPlanet(42);
  st.current.mutations = ['green-moon'];
  const gm3 = L.makeMineral(st, { family: 'moon', mutation: 'green-moon', source: 'salvage' });
  st.minerals.push(gm3);
  const ok3 = L.attemptMutation(st, gm3.id, () => 0.1);
  eq('apply: already-has-it is blocked', ok3.ok, false);
  eq('apply: blocked mineral stays in inventory', st.minerals.some((m) => m.id === gm3.id), true);
  // Family mineral: constant rng 0.0 picks the first candidate the
  // planet doesn't own (moon family order: big-moon first) and the
  // same stream's second draw (0.0 < 0.5) lands it.
  st = freshWithPlanet(42);
  st.current.mutations = [];
  const fam = L.makeMineral(st, { family: 'moon', mutation: null, source: 'salvage' });
  st.minerals.push(fam);
  const ok4 = L.attemptMutation(st, fam.id, () => 0.0);
  eq('apply: family mineral tries big-moon first', ok4.mutationId, 'big-moon');
  eq('apply: family attempt succeeds', ok4.success, true);
  check('apply: big moon baked (a moon is radius 5)',
    st.current.moons.some((m) => m.radius === 5.0 && (m.mutantIds || []).includes('big-moon')));
  // Family mineral blocked when the planet owns the whole family.
  st = freshWithPlanet(42);
  st.current.mutations = ['big-moon', 'green-moon', 'blood-moon'];
  const fam2 = L.makeMineral(st, { family: 'moon', mutation: null, source: 'salvage' });
  st.minerals.push(fam2);
  const ok5 = L.attemptMutation(st, fam2.id, () => 0.1);
  eq('apply: whole family owned is blocked', ok5.ok, false);
  eq('apply: blocked family mineral stays', st.minerals.some((m) => m.id === fam2.id), true);
  eq('apply: unknown id rejected', L.attemptMutation(st, 'min-999', () => 0.1).ok, false);
  st = L.freshState();
  eq('apply: no current planet rejected', L.attemptMutation(st, 'min-1', () => 0.1).ok, false);
  // Feeding is gone (round 10): no fed slot, no feed function, no tilt builder.
  eq('apply: no fed slot on a fresh state', st.fedMineral, undefined);
  eq('apply: feedMineral no longer exists', typeof L.feedMineral, 'undefined');
  eq('apply: takeTilt no longer exists', typeof L.takeTilt, 'undefined');
}

// 12c. A tilt really tilts the birth roll (measured over 2000 seeds:
// moon-family rate ~2% plain, ~20% tilted). The tilt mechanism is
// the prestige inheritance tilt (round 10: feeding is gone, so the
// only tilt left is prestige) — the generatePlanet tilt parameter
// itself is unchanged.
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
  check('tilt: a moon tilt raises the moon-mutation rate (>10%)', fedMoon / N > 0.10, `${(100 * fedMoon / N).toFixed(1)}% tilted`);
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
// mutation PLUS one extra plain mineral (round 10 perk); a plain
// planet yields one plain mineral (stable per seed).
{
  const gm = L.yieldMineralsForPlanet(Planet.generatePlanet(carrierSeed('green-moon')));
  eq('salvage: mutated planet yields two minerals', gm.length, 2);
  eq('salvage: first carries the mutation', gm[0].mutation, 'green-moon');
  eq('salvage: family matches the mutation', gm[0].family, 'moon');
  eq('salvage: bonus is a plain mineral', gm[1].mutation, null);
  check('salvage: bonus family is a real family', L.CONFIG.MINERAL_FAMILIES.includes(gm[1].family));
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
  check('salvage: a two-mutation planet yields three minerals (2 + bonus)',
    two && L.yieldMineralsForPlanet(two).length === 3, two ? two.mutations.join('+') : 'no two-mutation seed found');
}

// 12e. Recycle: destroy the current planet for minerals, hatch a fresh
// one immediately. The destroyed planet is NOT archived.
st = freshWithPlanet(carrierSeed('green-moon'));
const rc = L.recycleCurrent(st, seedSeq(3000));
eq('recycle: ok', rc.ok, true);
eq('recycle: yields the mutation mineral + bonus', rc.minerals.length, 2);
eq('recycle: mineral is the green moon', rc.minerals[0].mutation, 'green-moon');
eq('recycle: generation +1', st.generation, 2);
eq('recycle: new planet is Dust cloud', L.stageForXp(st.current.xp), 0);
eq('recycle: destroyed planet NOT archived', st.past.length, 0);
eq('recycle: new seed differs', st.current.seed !== carrierSeed('green-moon'), true);
eq('recycle: mineral in inventory', st.minerals.some((m) => m.mutation === 'green-moon'), true);
check('recycle: the destroyed planet\'s mutation stays discovered', st.discovered.includes('green-moon'));
st = freshWithPlanet(42);
L.recycleCurrent(st, seedSeq(4000));
eq('recycle: no fed slot exists anymore', st.fedMineral, undefined);
st = L.freshState();
eq('recycle: no current planet is a no-op', L.recycleCurrent(st, seedSeq()).ok, false);

// 12f. Salvage an archived planet: minerals out, record gone, no new planet.
st = freshWithPlanet(carrierSeed('glitch'));
L.applyXp(st, 500, seedSeq());
L.newPlanet(st, seedSeq(8000));
eq('salvage: one archived planet', st.past.length, 1);
const sv = L.salvageArchived(st, 0);
eq('salvage: ok', sv.ok, true);
eq('salvage: yields the glitch mineral + bonus', sv.minerals.length, 2);
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
// Inheritance chances (Devon, Nov 12): 50% if one parent has it,
// 75% if both — inheritance is genetics, not a lottery ticket. The
// tilt machinery still speaks multipliers, so the boost is the
// chance divided by the base; these checks read the effective
// chance, not the raw boost number.
eq('inherit: one-parent chance is 50%', L.CONFIG.PRESTIGE_INHERIT_CHANCE_ONE, 0.5);
eq('inherit: both-parents chance is 75%', L.CONFIG.PRESTIGE_INHERIT_CHANCE_BOTH, 0.75);
check('inherit: one-parent boost is the chance over the base',
  Math.abs(L.inheritanceBoosts(['green-moon'], [])['green-moon'] * Planet.CONFIG.MUTATION_CHANCE - 0.5) < 1e-9);
check('inherit: both-parents boost is the chance over the base',
  Math.abs(L.inheritanceBoosts(['green-moon'], ['green-moon'])['green-moon'] * Planet.CONFIG.MUTATION_CHANCE - 0.75) < 1e-9);
check('inherit: unshared mutations stay at the one-parent chance',
  Math.abs(L.inheritanceBoosts(['green-moon'], ['blood-moon'])['blood-moon'] * Planet.CONFIG.MUTATION_CHANCE - 0.5) < 1e-9);
{
  // The chance is real in the roll: green-moon at 50% over 2000
  // seeds (expected ~1000 hits vs ~14 base — no flake possible at
  // this gap, unlike the old 3x-over-0.7% measurement).
  let base = 0, inherited = 0;
  const N = 2000;
  const tilt50 = { boosts: { 'green-moon': L.inheritanceBoosts(['green-moon'], [])['green-moon'] } };
  for (let s = 0; s < N; s++) {
    if (Planet.generatePlanet(s).mutations.includes('green-moon')) base++;
    if (Planet.generatePlanet(s, null, tilt50).mutations.includes('green-moon')) inherited++;
  }
  check('inherit: 50% tilt lands green-moon about half the time',
    inherited > N * 0.4 && inherited < N * 0.6, `${inherited} / ${N} (base ${base})`);
}
// prestigeTilt (round 10): the ONLY tilt left — inheritance only,
// no fed mineral anymore. A fed mineral cannot stack on top because
// there is no fed mineral.
eq('prestigeTilt: null with no boosts', L.prestigeTilt(null), null);
eq('prestigeTilt: inheritance boosts pass through',
  L.prestigeTilt({ 'green-moon': 2 }).boosts['green-moon'], 2);
eq('prestigeTilt: empty boosts is a null tilt', L.prestigeTilt({}), null);

// 12h. Persistence: minerals + discovered survive a round-trip, and
// old saves (from before minerals) get the one-time starter gift.
// A pre-round-10 save with a legacy fedMineral migrates: its mutation
// is discovered, and the fed slot is deleted — there is no fed slot
// anymore.
st = freshWithPlanet(42);
const loaded2 = L.deserializeState(L.serializeState(st));
eq('persist: minerals survive', loaded2.minerals.length, st.minerals.length);
eq('persist: discovered survives', loaded2.discovered.join(','), st.discovered.join(','));
eq('persist: starter flag survives', loaded2.starterMineralGranted, true);
const migrated = L.deserializeState('{"version":1,"current":null,"past":[],"generation":1,"starterDone":true}');
eq('persist: old save gets the starter gift', migrated.minerals.length, 1);
eq('persist: old save starter is crystal', migrated.minerals[0].kind, 'crystal');
eq('persist: old save flag set', migrated.starterMineralGranted, true);
const legacy = L.deserializeState(JSON.stringify({
  version: 1,
  current: { seed: 42, xp: 0, mutations: ['glitch'] },
  past: [{ seed: 7, mutations: ['comet'] }],
  generation: 1, starterDone: true, minerals: [],
  fedMineral: { id: 'min-9', kind: 'mutation', family: 'moon', mutation: 'green-moon', source: 'salvage' },
  mineralSeq: 9, starterMineralGranted: true,
}));
check('persist: legacy fed mineral mutation is discovered', legacy.discovered.includes('green-moon'));
check('persist: legacy current mutation is discovered', legacy.discovered.includes('glitch'));
check('persist: legacy archived mutation is discovered', legacy.discovered.includes('comet'));
eq('persist: legacy fed slot is deleted', legacy.fedMineral, undefined);
const summary = L.mineralSummary(freshWithPlanet(42));
eq('summary: one mineral total', summary.total, 1);
eq('summary: one glow mineral', summary.byFamily.glow, 1);
eq('summary: no fed field anymore', summary.fed, undefined);

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
check('overflow: the new planet is the current one', np2.planet === st.current);

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
check('ext: sun defaults to the finer 84x42 grid (smaller cells, same display size)',
  extSrc.includes('cols = 84') && extSrc.includes('rows = 42')
  && extSrc.includes('P.gridToHtml(grid, cellW, cellH)'));
check('ext: sun granulation churns over time (sec-dependent)',
  extSrc.includes('function starHtml(sec, cols, rows, cellW, cellH)') && extSrc.includes('Math.sin(sec * 0.9'));
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
check('ext: limb flames fizzle on their own phase (slowed 3.1 -> 1.5 in round 2 — the old rate strobed at the frame rate)',
  extSrc.includes('LIMB FLAMES') && extSrc.includes('Math.sin(sec * 1.5'));
// Limb flames fizzle (Devon, Nov 11 — the fringe was frozen in every
// clip: measured only 17% of halo cells ever changed, 1.4% per tick).
// Run the real starHtml and measure the fringe band (d2rel in 1..1.3,
// i.e. just outside the DISC EDGE) directly: a visible share must
// change within a second, while the look stays the same (same lit
// count, '.'-dominant). The band is measured against the moving edge
// (d2rel with the real edgeRadius), not the fixed geometric radius —
// flame-tongue disc cells would otherwise pollute the band.
(function () {
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec, cols, rows, cellW, cellH) {'), extSrc.indexOf('// --- orrery'));
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
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec, cols, rows, cellW, cellH) {'), extSrc.indexOf('// --- orrery'));
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
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec, cols, rows, cellW, cellH) {'), extSrc.indexOf('// --- orrery'));
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
(function () {
  const sysHtml = extSrc.slice(extSrc.indexOf('  getSystemHtml(webview) {'), extSrc.indexOf('  getPrestigeHtml(webview) {'));
  check('ext: sun and discs re-render every tick (never frozen, no more 2.2fps discs)',
    sysHtml.includes('renderDiscs();\n    renderStar();') && !sysHtml.includes('tick % 2') && !sysHtml.includes('tick % 3'));
})();
// The sun re-renders at a resolution matching its on-screen size
// (Devon, Nov 12 — continuous zoom detail): starHtml takes
// cols/rows/cell size, defaulting to the old 84x42. Run the real
// starHtml at a small and a large resolution and check the grid size
// and the brightness rules (brightest 229, never 231) hold at both.
(function () {
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec, cols, rows, cellW, cellH) {'), extSrc.indexOf('// --- orrery'));
  const starHtml = new Function('P', starSrc + '\nreturn starHtml;')({
    noise2: Planet.noise2,
    gridToHtml: (grid) => grid,
  });
  const small = starHtml(5, 42, 21);
  const large = starHtml(5, 168, 84);
  const def = starHtml(5);
  check('sun resolution: starHtml renders the requested grid size',
    small.length === 21 && small[0].length === 42 && large.length === 84 && large[0].length === 168
    && def.length === 42 && def[0].length === 84,
    `${small[0].length}x${small.length} / ${large[0].length}x${large.length} / default ${def[0].length}x${def.length}`);
  let maxCol = 0, has231 = false, lit = 0;
  for (const row of small) for (const [ch, col] of row) {
    if (col !== null) { maxCol = Math.max(maxCol, col); if (col === 231) has231 = true; if (ch !== ' ') lit++; }
  }
  check('sun resolution: brightest color is 229, never 231, at small size too',
    maxCol <= 229 && !has231 && maxCol >= 208 && lit > 50,
    'max ' + maxCol + ', ' + lit + ' lit cells');
})();
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
check('ext: orrery discs render from the continuous detail grid (not tiers, not 68x38)',
  extSrc.includes('P.discBlend(zoom, zcrop, detail, isSel)')
  && extSrc.includes('P.render(d.planet.planet, d.planet.stageIdx, 10, sec, discZoom, undefined, 0.5, true)')
  && extSrc.includes('P.downsampleGrid(cropped, bl.outCols, bl.outRows)')
  && !extSrc.includes('68, 38), 3.4, 6.12') && !extSrc.includes('discTier'));
check('ext: detail panel uses the cropped full render, not the cozy downsample',
  extSrc.includes('function fillDetailArt()')
  && extSrc.includes('P.cropGrid(P.render(planet.planet, planet.stageIdx, 10, sec, 1.0, undefined, 0.5, true), crop)')
  && extSrc.includes('P.sidebarCrop(planet.planet, planet.stageIdx, 10)')
  && extSrc.includes("gridEl.style.setProperty('--pp-fs', cellFont(cellW, cellH) + 'px')"));
// The detail sheet uses the full render, not the cozy downsample —
// the 4.4/7.92 cells now belong to the Index tiles, so this scopes
// the check to renderDetail itself instead of the whole file.
(function () {
  const detailSrc = extSrc.slice(extSrc.indexOf('function renderDetail() {'), extSrc.indexOf('function indexSignature() {'));
  check('ext: detail sheet uses the cropped full render, not the cozy downsample',
    detailSrc.includes('fillDetailArt()')
    && detailSrc.includes('P.cropGrid(P.render(planet.planet, planet.stageIdx, 10, sec, 1.0, undefined, 0.5, true), crop)')
    && detailSrc.includes('P.sidebarCrop(planet.planet, planet.stageIdx, 10)')
    && !detailSrc.includes('renderCozy'), detailSrc.slice(0, 200));
})();
check('ext: card mutation badge keeps the full MUTATION label',
  extSrc.includes("'<span class=\"badge mut\">' + esc(p.mutationLabel)") &&
  !extSrc.includes("mutationLabel.replace('MUTATION"));
check('ext: card shows the stage', extSrc.includes('esc(p.stageName)'));
check('ext: discs share one z-index — no depth sorting (separation is geometric)',
  extSrc.includes("d.el.style.zIndex = '100'") && !extSrc.includes('10 + Math.round(pos.y)'));
check('ext: no name labels on the orrery', !extSrc.includes('discName'));
// --- Continuous zoom detail + F5 feedback (Nov 12) -----------------------
// The orrery planet was a pixelated blob while the detail sheet looked
// good (stepped tiers + CSS-scaled glyphs); the sun was a blob at any
// zoom; hiding the UI left no way back; the sidebar pet sat small in
// a black box; the Index showed a gray rectangle with a speck.
check('ext: disc detail follows the camera zoom directly (continuous, not stepped)',
  extSrc.includes('return P.discDetail(zoom);') && extSrc.includes('P.sunDetail(zoom)'));
check('ext: discs + star counter-scale so glyphs stay at final size',
  extSrc.includes('scale(var(--inv-zoom, 1))') && extSrc.includes("setProperty('--inv-zoom'"));
check('ext: hide-UI pill exists, hidden by default, shown while hidden',
  extSrc.includes('id="showUiPill"') && extSrc.includes('#showUiPill { display: none;')
  && extSrc.includes('body.hide-ui #showUiPill { display: block; }'));
check('ext: hide-UI pill click brings the UI back',
  extSrc.includes("getElementById('showUiPill')") && extSrc.includes("classList.remove('hide-ui')"));
check('ext: Index grid has no gray background (panel black, hairline tiles)',
  extSrc.includes('#tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 0; background: #050505; }'));
check('ext: sidebar pet sits in a rounded gray card (Devon, Nov 12 — round 3 Pokechi-style; the flat #171717 square card was round 2)',
  extSrc.includes('#wrap { background: #2b2b2b; border: 1px solid #3d3d3d; border-radius: 10px;')
  && !extSrc.includes('#wrap { background: transparent; border: none;')
  && !extSrc.includes('#wrap { background: #171717;'));
check('ext: sidebar XP bar + label live inside the card (Pokechi-style, round 3)',
  extSrc.includes('<div id="wrap"><pre class="pp-grid" id="grid"></pre><div id="xpbar">')
  && extSrc.includes('</div><div id="xplabel">XP 0 / 100</div></div>'));
check('ext: sidebar stage line hides at minimum sizes (round 3 — the stage is in the detail sheet / Index)',
  extSrc.includes('body.compact #stageName { display: none; }'));
check('ext: sidebar reserve measures the body padding (round 3 — compact shrinks it, a hardcoded 24 over-reserved)',
  extSrc.includes('getComputedStyle(document.body)') && extSrc.includes('parseFloat(bodyCs.paddingTop)'));
check('ext: sidebar never replays a birth morph, on load or on a new planet (round 8 — Devon: the morph read as a destroy animation and lagged)',
  !extSrc.includes('if (!state || msg.stageIdx !== lastStage) stageStartSec = sec;')
  && extSrc.includes('stageStartSec = sec - 10; // settled — no birth morph'));
check('ext: share panel does NOT replay the birth morph on load (round 3 — same bug, full-grid re-render; round 8: the sidebar no longer shares that line, so it appears once, in the share card)',
  extSrc.includes("if (msg.type === 'share')") && (extSrc.match(/stageStartSec = msg\.chars === 0 \? sec : sec - 10;/g) || []).length === 1);
check('ext: sidebar tick debounces layout on crop changes (round 3 — the morph is gone in round 8, so the crop only changes on a stage change)',
  extSrc.includes('layoutPending = true') && extSrc.includes('sec - lastLayoutAt >= 0.5')
  && extSrc.includes('layoutPending && (sec - lastLayoutAt >= 0.5 || t >= 3)'));
check('ext: sidebar never scrolls (height-aware layout, XP always visible)',
  extSrc.includes('body.compact') && extSrc.includes("mt.style.display = 'none'")
  && extSrc.includes('body { margin: 0; padding: 10px; background: transparent; overflow: hidden;'));
// Round 2, second pass: the first height-fit forgot the dark card's
// own padding+border (18px) and still scrolled 23px at 150px height,
// and the fitted cells dropped to 1.7px dots. The reserve now
// measures the card chrome, and short views render the crop
// downsampled (half, then quarter) so the cells stay readable.
check('ext: sidebar height reserve includes the dark-card chrome',
  extSrc.includes('wrapEl.offsetHeight - (gridEl0 ? gridEl0.offsetHeight : 0)'));
check('ext: sidebar reserve uses measured margins, not hardcoded guesses',
  extSrc.includes('getComputedStyle(el)') && extSrc.includes('parseFloat(cs.marginTop)')
  && extSrc.includes('parseFloat(cs.marginBottom)'));
check('ext: sidebar renders a coarser grid at short heights (readable floor ~4px)',
  extSrc.includes('lastDims') && extSrc.includes('P.downsampleGrid(cropped, lastDims.cols, lastDims.rows)')
  && extSrc.includes('newH >= 4.2'));
check('ext: sidebar grid is centered in the card (a narrow coarse grid must not hug the left edge)',
  extSrc.includes('.pp-grid { margin: 0; text-align: center;'));
check('ext: sidebar has no stale scrollHeight backstop (it over-shrinks on the old row count)',
  !extSrc.includes('document.documentElement.scrollHeight') || !extSrc.includes('applyCells(Math.max(1, +(cellW * k)'));
check('ext: sidebar pet renders cropped + star-free',
  extSrc.includes('P.sidebarCrop(state.planet, state.stageIdx, t)')
  && extSrc.includes('P.cropGrid(full, lastCrop)')
  && extSrc.includes('P.render(state.planet, state.stageIdx, t, sec, 1.0, undefined, 1, true)'));
check('ext: no "+" buttons on empty rings (ringHit hit-areas instead)',
  !extSrc.includes('ringBtn') && extSrc.includes("className = 'ringHit'"));

// 13l. Batch #9 (Devon, Nov 11, 11:36 PM — queued notes, fixed Nov 12):
// (1) plain scroll does nothing (the panel is one viewport now — the
// Index is its own mode, reached from the tabs — so there is no page
// to scroll); plain scroll zooms, no Ctrl needed (Devon, Nov 13 — the
// Index is its own screen now, so there is no page to scroll); (2) hovering a ring
// highlights the ring itself, no separate gold ring drawn above it;
// (3) no 'Sol' label under the sun; (4) no standing-still stars
// around the sun; (5) Shattered birth smoke stays close to the core
// in the solar-system renders.
// (1) Wheel zoom: plain scroll zooms, no Ctrl needed (Devon, Nov 13 —
// the Index is its own screen now, so there is no page to scroll).
(function () {
  const wheelSrc = extSrc.slice(extSrc.indexOf("addEventListener('wheel'"), extSrc.indexOf("addEventListener('wheel'") + 1000);
  check('ext: plain scroll zooms (no ctrl/meta gate before preventDefault)',
    wheelSrc.indexOf('if (!e.ctrlKey') === -1
    && wheelSrc.indexOf('e.preventDefault()') !== -1
    && wheelSrc.indexOf('e.preventDefault()') < wheelSrc.indexOf('zoom = Math.max'),
    wheelSrc.slice(0, 220));
  check('ext: scroll zooms (cap 6x, round 3 — was 3x; round 4 halved the per-event step)',
    wheelSrc.includes('zoom = Math.max(0.3, Math.min(6, zoom * Math.exp(-e.deltaY * 0.0005)))'));
  check('ext: zoom hint names Scroll to zoom', extSrc.includes('Scroll to zoom'));
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
  const starSrc = extSrc.slice(extSrc.indexOf('function starHtml(sec, cols, rows, cellW, cellH) {'), extSrc.indexOf('// --- orrery'));
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
  check('ext: solar-system renders pass the reduced smoke scale (orrery, detail, index, tick)',
    extSrc.includes('P.render(d.planet.planet, d.planet.stageIdx, 10, sec, discZoom, undefined, 0.5, true)')
    && extSrc.includes('P.render(planet.planet, planet.stageIdx, 10, sec, 1.0, undefined, 0.5, true)')
    && extSrc.includes('P.render(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx), undefined, 0.5, true)'));
  check('ext: sidebar pet and prestige renders keep the full smoke (default scale)',
    extSrc.includes('P.render(state.planet, state.stageIdx, t, sec, 1.0, undefined, 1, true)')
    && extSrc.includes('P.renderCozy(p.planet, p.stageIdx, 10, 5, 1.0, 34, 19, undefined, 1, true), 3.4, 6.12)'));
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
// Round 3 (Devon, Nov 12 — red/orange Accretion in the panel): the
// fallback re-roll in renderablePlanet must pass the stored starter
// terrain, or a starter-picked planet comes back with the wrong
// terrain (GJ-364c: icy by pick, lava by weighted re-roll).
check('ext: panel re-roll passes the stored starter terrain',
  extSrc.includes('generatePlanet(record.seed, record.terrain)'));
// The invariant the fix relies on: the starter pick consumes one rng
// draw, so the re-roll with the stored terrain reproduces the planet
// exactly — only the terrain differs without it.
const gjLive = L.makePlanet(948502300, 'icy');
const gjReroll = Planet.generatePlanet(948502300);
const gjFixed = Planet.generatePlanet(948502300, 'icy');
check('panel: re-roll without the starter terrain picks the wrong terrain (lava, not icy)',
  gjReroll.terrain === 'lava' && gjLive.terrain === 'icy',
  `reroll=${gjReroll.terrain} live=${gjLive.terrain}`);
check('panel: re-roll WITH the stored terrain reproduces the planet exactly',
  gjFixed.terrain === 'icy' && JSON.stringify(gjFixed.bands) === JSON.stringify(gjLive.bands)
    && JSON.stringify(gjFixed.moons) === JSON.stringify(gjLive.moons)
    && gjFixed.ringType === gjLive.ringType && gjFixed.size === gjLive.size,
  `fixed=${gjFixed.terrain}`);
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
check('ext: the fed-mineral line is gone from the prestige panel (round 10)',
  !extSrc.includes('Fed:') && extSrc.includes('both parents carry it')
  && extSrc.includes('Anything else can still appear at its usual rare odds'));
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

// 15a. Seed-hatch terrain tag (Nov 12): a planet whose terrain was
// pinned by a starter pick shares its seed tagged with the terrain;
// a planet whose terrain is what its seed rolls anyway shares bare.
eq('share: bare seed for a planet whose terrain matches its seed roll',
  L.shareSeedFor({ seed: 805839337, terrain: 'toxic' }), '805839337');
eq('share: tagged seed for a starter-picked planet (GJ-364c)',
  L.shareSeedFor({ seed: 948502300, terrain: 'icy' }), '948502300-icy');
eq('share: bare seed when no terrain is stored',
  L.shareSeedFor({ seed: 948502300 }), '948502300');
eq('share: bare seed for an unknown terrain',
  L.shareSeedFor({ seed: 948502300, terrain: 'bogus' }), '948502300');
const taggedMd = L.shareCardMarkdown(
  { ...sharePlanet, seed: 948502300, terrain: 'icy', terrainLabel: 'Icy world', name: 'GJ-364c', mutationLabel: null },
  'protoplanet-gj-364c-gen1.png');
check('share: markdown embeds the tagged seed for a starter-picked planet',
  taggedMd.includes('Seed `948502300-icy`'), taggedMd);
check('share: markdown still names the tagged planet',
  taggedMd.includes('**GJ-364c** · Icy world'), taggedMd);

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
check('ext: share canvas uses the full-density render (same grid as the panel)', extSrc.includes('P.render(state.planet, state.stageIdx,') && extSrc.includes('sec, 1.0);'));
// drawPng passed P.CONFIG.W/H as stage0Style/smokeScale (Nov 12 —
// stage 0 drew as a sparse 264-cell core instead of 670). The fix
// calls render with just the zoom and lets the defaults apply.
check('ext: share PNG render call passes no stage0Style/smokeScale args',
  extSrc.includes('Math.max(0, sec - stageStartSec), sec, 1.0);') && !extSrc.includes('P.CONFIG.W, P.CONFIG.H)'));
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

// parseSeedInput, tagged form (Nov 12 seed-hatch fix): "seed-terrain"
// hatches the pinned terrain. The terrain is a note on the share —
// the seed number never changes.
eq('seed input: tagged seed', L.parseSeedInput('948502300-icy').ok, true);
eq('seed input: tagged seed value', L.parseSeedInput('948502300-icy').seed, 948502300);
eq('seed input: tagged seed terrain', L.parseSeedInput('948502300-icy').terrain, 'icy');
eq('seed input: bare seed has no terrain', L.parseSeedInput('805839337').terrain, null);
eq('seed input: terrain is case-insensitive', L.parseSeedInput('948502300-ICY').terrain, 'icy');
eq('seed input: spaces around the hyphen', L.parseSeedInput('948502300 - icy').terrain, 'icy');
check('seed input: bad terrain rejected', L.parseSeedInput('948502300-bogus').ok === false);
check('seed input: trailing hyphen rejected', L.parseSeedInput('948502300-').ok === false);
check('seed input: double suffix rejected', L.parseSeedInput('948502300-icy-extra').ok === false);
check('seed input: tagged out-of-range rejected', L.parseSeedInput('1000000000-icy').ok === false);

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
    JSON.stringify({ ...L.makeSeedPlanet(mutSeed, new Set()), journal: undefined })
    === JSON.stringify({ ...hatched, journal: undefined }));
}

// Tagged hatch (Nov 12 seed-hatch fix): "948502300-icy" hatches the
// pinned icy planet — the same base planet as Devon's live GJ-364c
// (born from the icy starter pick), mutations stripped.
{
  const live = L.makePlanet(948502300, 'icy');
  const hatched = L.makeSeedPlanet(948502300, new Set(), 'icy');
  const base = Planet.stripMutations(Planet.generatePlanet(948502300, 'icy'));
  check('seed planet tagged: terrain is the pinned one', hatched.terrain === 'icy' && hatched.terrain === live.terrain);
  check('seed planet tagged: same name as the live planet', hatched.name === live.name);
  check('seed planet tagged: same size as the live planet', hatched.size === live.size);
  check('seed planet tagged: same rings as the live planet', hatched.ringType === base.ringType && hatched.baseRingType === live.baseRingType);
  check('seed planet tagged: same moons as the live planet', hatched.moons.length === live.moons.length && JSON.stringify(hatched.moons) === JSON.stringify(base.moons));
  check('seed planet tagged: no mutations', hatched.mutations.length === 0);
  check('seed planet tagged: deterministic',
    JSON.stringify({ ...L.makeSeedPlanet(948502300, new Set(), 'icy'), journal: undefined })
    === JSON.stringify({ ...hatched, journal: undefined }));
  check('seed planet tagged: journal seeds the same birth text',
    L.makeSeedPlanet(948502300, new Set(), 'icy').journal[0].text === hatched.journal[0].text);
}
// The bare seed keeps the old behavior: GJ-364c's seed without the
// tag hatches the seed's canonical terrain (lava), not the pinned
// icy one — the documented fallback.
{
  const bare = L.makeSeedPlanet(948502300, new Set());
  check('seed planet bare: GJ-364c seed without the tag hatches lava', bare.terrain === 'lava');
  check('seed planet bare: rings/moons/size/name still match the pinned twin except terrain',
    bare.ringType === Planet.generatePlanet(948502300, 'icy').ringType
    && bare.size === Planet.generatePlanet(948502300, 'icy').size
    && bare.name === Planet.generatePlanet(948502300, 'icy').name);
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
  const p = L.hatchFromSeed(st, 805839337).planet;
  check('seed hatch: current archived', st.past.length === 1 && st.past[0].seed === mutSeed);
  check('seed hatch: archived planet KEEPS its mutations', JSON.stringify(st.past[0].mutations) === JSON.stringify(oldMuts), oldMuts.join(','));
  check('seed hatch: generation +1', st.generation === 2);
  check('seed hatch: current is the seed planet', st.current === p && p.seed === 805839337);
  check('seed hatch: hatched planet has no mutations', p.mutations.length === 0);
  check('seed hatch: hatched planet is the canonical roll', p.terrain === Planet.generatePlanet(805839337).terrain && p.name === Planet.generatePlanet(805839337).name);
}
// Tagged hatch through hatchFromSeed: the full command path with a
// tagged seed hatches the pinned terrain, generation +1, archive kept.
{
  const live = L.makePlanet(948502300, 'icy');
  const st = freshWithPlanet(42);
  const p = L.hatchFromSeed(st, 948502300, 'icy').planet;
  check('seed hatch tagged: current is the pinned planet', st.current === p && p.seed === 948502300 && p.terrain === 'icy');
  check('seed hatch tagged: same name/size/rings as the live planet',
    p.name === live.name && p.size === live.size && p.ringType === live.ringType);
  check('seed hatch tagged: no mutations', p.mutations.length === 0);
  check('seed hatch tagged: generation +1', st.generation === 2);
  check('seed hatch tagged: old planet archived', st.past.length === 1 && st.past[0].seed === 42);
}
// A seed hatch leaves the inventory alone — the hatch is the seed's
// canonical planet, not a roll, so no mineral is spent or tilted.
{
  const st = freshWithPlanet(42);
  const before = st.minerals.length;
  L.hatchFromSeed(st, 805839337);
  check('seed hatch: inventory untouched', st.minerals.length === before);
  check('seed hatch: no fed slot exists', st.fedMineral === undefined);
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
  const p = L.hatchFromSeed(st, 42).planet;
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
check('ext: hatchFromSeed passes the parsed terrain through', extSrc.includes('Logic.hatchFromSeed(this.state, parsed.seed, parsed.terrain)'));
check('ext: hatchFromSeed confirms with a modal warning', extSrc.includes('Yes, hatch it'));
check('ext: share view model carries the shared seed', extSrc.includes('shareSeed: Logic.shareSeedFor(p)'));
check('ext: share copies the shared seed string', extSrc.includes('shareViewModel().shareSeed'));
check('ext: share panel shows the shared seed', extSrc.includes('state.shareSeed || state.seed'));
check('ext: share PNG caption uses the shared seed', extSrc.includes("(state.shareSeed || state.seed)"));

// 17. Instrument redesign (Devon, Nov 12): the solar-system panel is
// two full-screen modes (Orrery / Index) in the Instrument style —
// near-black, hairline rules, mono type, one amber accent, no cards,
// no dashboard chrome. Clicking a planet zooms the camera into it
// and shows its details beside it (the old detail modal covered the
// orrery); X / Esc zooms back out. Archive is renamed Index.
(function () {
  const sysHtml = extSrc.slice(extSrc.indexOf('  getSystemHtml(webview) {'), extSrc.indexOf('  getPrestigeHtml(webview) {'));
  // Modes: two full screens, not one crowded one.
  check('ext: orrery/index mode tabs exist', sysHtml.includes('id="tabOrrery"') && sysHtml.includes('id="tabIndex"'));
  check('ext: mode switch toggles the body class', sysHtml.includes("document.body.classList.toggle('mode-index', m === 'index')"));
  check('ext: index is its own full-screen section', sysHtml.includes('id="index"') && sysHtml.includes('id="tiles"'));
  check('ext: index tiles are big (340px min, hairline-separated, no gray box)',
    sysHtml.includes('grid-template-columns: repeat(auto-fill, minmax(340px, 1fr))') && sysHtml.includes('gap: 0; background: #050505;'));
  check('ext: index tiles use the cropped full render like the sidebar (not the 68x38 cozy downsample)',
    sysHtml.includes('function fillTileArt(')
    && sysHtml.includes('P.render(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx), undefined, 0.5, true)')
    && sysHtml.includes('P.sidebarCrop(p.planet, p.stageIdx, 10)')
    && sysHtml.includes('P.cropGrid(P.render(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx), undefined, 0.5, true), crop)')
    && !sysHtml.includes('P.renderCozy(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx), 68, 38'));
  check('ext: no card chrome in the system panel',
    !sysHtml.includes('class="card') && !sysHtml.includes('id="cards"') && !sysHtml.includes('border-radius: 8px'));
  check('ext: bottom strip holds the zoom controls + hint', sysHtml.includes('id="bottomStrip"') && !sysHtml.includes('orreryHint'));
  // Zoom-to-planet replaces the detail modal.
  check('ext: clicking a planet zooms the camera into it',
    sysHtml.includes('function zoomToPlanet(') && sysHtml.includes('zoomToPlanet(planet)'));
  check('ext: zoom restores the previous view on close',
    sysHtml.includes('function unzoom(') && sysHtml.includes('prevView = { zoom: zoom, panX: panX, panY: panY }'));
  check('ext: detail sheet is fixed beside the zoomed planet', sysHtml.includes('position: fixed; right: 16px'));
  check('ext: drift pauses while the detail sheet is open (incl. while zoomed)',
    sysHtml.includes('if (!hoverPlanet && !detailOpen)')
    && sysHtml.includes("if (mode === 'orrery') zoomToPlanet(planet);"));
  // Hide-UI (H).
  check('ext: H hides the interface', sysHtml.includes("classList.toggle('hide-ui')") && sysHtml.includes('body.hide-ui'));
  // Instrument style: mono type, one amber accent, no green badge.
  check('ext: system panel uses a monospace stack', sysHtml.includes("ui-monospace, SFMono-Regular, Menlo"));
  check('ext: no green badge left in the system panel', !sysHtml.includes('#7ee2a8'));
  // Rename: no user-facing "Archive" / "Pokédex" left in the panel
  // (the only "Archive" strings left are two comments explaining the
  // rename, and the archivedAt data field — not UI).
  check('ext: archive renamed to index (no archive/pokedex UI strings)',
    !sysHtml.includes('id="archive"') && !sysHtml.includes('<h2>Archive</h2>')
    && !sysHtml.includes('Scroll down for the Archive') && !sysHtml.includes('Pokédex') && !sysHtml.includes('Pokedex')
    && sysHtml.includes('id="index"'));
  check('ext: view model calls the collection index, not archive',
    extSrc.includes('const index = this.state.past.map') && extSrc.includes('totalPlanets: index.length,')
    && !extSrc.includes('const archive = this.state.past.map'));
})();

// 18. Solar-system disc rules (Devon, Nov 12): stage-driven scale, no
// per-planet stars in the orrery/Index, full rings in the orrery.
// The engine side (stageScale values, noStars behavior, ringFitZoom
// fit) is covered in test-planet.js §18; this checks the wiring.
(function () {
  const sysHtml = extSrc.slice(extSrc.indexOf('  getSystemHtml(webview) {'), extSrc.indexOf('  getPrestigeHtml(webview) {'));
  check('ext: orrery discs scale with stage and fit their rings',
    sysHtml.includes('Math.min(P.stageScale(d.planet.stageIdx),')
    && sysHtml.includes('P.ringFitZoom(d.planet.planet, d.planet.stageIdx, detail.cols, detail.rows)'));
  check('ext: index tiles scale with stage', sysHtml.includes('P.stageScale(p.stageIdx)'));
  check('ext: orrery discs and index tiles drop the per-planet stars',
    sysHtml.includes('P.render(d.planet.planet, d.planet.stageIdx, 10, sec, discZoom, undefined, 0.5, true)')
    && sysHtml.includes('P.cropGrid(P.render(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx), undefined, 0.5, true), crop)'));
  // The detail sheet keeps its stars — as a layer of the frame now,
  // not baked into the planet render (Devon, Nov 12 — §21).
  check('ext: detail sheet renders star-free with the starfield layer behind it',
    sysHtml.includes('P.render(planet.planet, planet.stageIdx, 10, sec, 1.0, undefined, 0.5, true)')
    && sysHtml.includes('id="detailArt" class="pp-frame"'));
  check('ext: sidebar pet is star-free (floats on the VS Code gray, no starfield box)',
    extSrc.includes('P.render(state.planet, state.stageIdx, t, sec, 1.0, undefined, 1, true)'));
  check('ext: no shared starfield added to the panel (plain black, per Devon)',
    !sysHtml.includes('id="starfield"') && !sysHtml.includes('starLayer')
    && !sysHtml.includes('backgroundStars') && !sysHtml.includes('renderStars'));
})();

// 19. Zoom detail + Index de-box (Devon, Nov 12): the orrery discs get
// denser as the camera zooms in (P.discDetail, continuous — glyph size
// never changes); the Index tiles have no amber border — 1px hairline
// gaps only, amber kept for the badges and the active tab; the Index
// header is one slim line and the rank line is trimmed.
(function () {
  const sysHtml = extSrc.slice(extSrc.indexOf('  getSystemHtml(webview) {'), extSrc.indexOf('  getPrestigeHtml(webview) {'));
  check('ext: discs use the continuous discDetail (no tiers)',
    sysHtml.includes('P.discDetail(') && sysHtml.includes('function discDetailNow()') && !sysHtml.includes('discTier'));
  check('ext: zoom gestures refresh the disc detail (rAF-gated, one re-render per frame)',
    (sysHtml.match(/scheduleZoomRefresh\(\)/g) || []).length >= 7
    && sysHtml.includes('function scheduleZoomRefresh()')
    && sysHtml.includes('refreshDiscDetail();'));
  // Round 3 (Devon, Nov 12): the zoomed disc showed half the detail
  // of its own sheet — the panel capped zoom at 3x, where discDetail
  // only reaches 69 cols, and clicking a planet landed at ~1.8x
  // (~41 cols). The cap is 6x everywhere now, clicking lands at
  // fitZoom x 5, and any disc at 2x+ renders cropped to the planet
  // (the selected-disc-only path, generalized) so the zoomed disc
  // matches its sheet.
  check('ext: zoom cap is 6x at all three clamp sites (wheel, zoom-in button, zoomToPlanet)',
    sysHtml.includes('zoom = Math.max(0.3, Math.min(6, zoom * Math.exp(-e.deltaY * 0.0005)))')
    && sysHtml.includes('zoom = Math.min(6, zoom * 1.25)')
    && sysHtml.includes('var zoomT = Math.min(6, Math.max(1.6, fitZoom * 5));')
    && !sysHtml.includes('Math.min(3, zoom') && !sysHtml.includes('fitZoom * 2.6'));
  // Round 4 (Devon, Nov 12): the 2x switch itself was a cliff — one
  // step jumped the disc 43 -> 288 chars — so the crop now blends in
  // over z=2..4 via P.discBlend; a selected disc jumps straight to
  // blend 1 (its sheet is open). The zoomed disc still matches its
  // sheet at high zoom (blend 1 is exactly the old cropped render).
  check('ext: any disc at high zoom renders cropped to the planet (not selected-only)',
    sysHtml.includes('P.discBlend(zoom, zcrop, detail, isSel)') && sysHtml.includes('var isSel = zoomed && selected'));
  check('ext: index tiles have no amber border (hairline gaps only)',
    !sysHtml.includes('.tile.inSystem') && !sysHtml.includes('.tile.picking')
    && sysHtml.includes('gap: 0; background: #050505;'));
  check('ext: Index tiles use the cropped full render, no downsample (round 3 — the tile path must be clean of the pixel-block source)',
    sysHtml.includes('P.cropGrid(P.render(p.planet, p.stageIdx, 10, 5, P.stageScale(p.stageIdx)')
    && !sysHtml.slice(sysHtml.indexOf('function fillTileArt'), sysHtml.indexOf('function fillTileArt') + 900).includes('downsampleGrid')
    && !sysHtml.slice(sysHtml.indexOf('function fillTileArt'), sysHtml.indexOf('function fillTileArt') + 900).includes('renderCozy'));
  check('ext: amber stays on badges and the active tab only',
    sysHtml.includes('.badge.sys') && sysHtml.includes('.tab.active') && sysHtml.includes('#e8b64c'));
  check('ext: index header is one slim line, no heading',
    !sysHtml.includes('<h2>Index</h2>') && sysHtml.includes('id="indexCount"'));
  check('ext: rank line is trimmed (rank + rings + to-next only)',
    sysHtml.includes("'Rank ' + state.rank") && !sysHtml.includes('finished planet'));
})();

// 20. Prestige Instrument restyle (Devon, Nov 12): the fusion panel gets
// the same Instrument chrome as the solar system panel — near-black,
// hairline rules, mono type, one amber accent, flat areas instead of
// rounded cards, hairline-outline buttons, no eyebrow microcopy. The
// collision, inheritance preview, two-step confirm, and picking are
// untouched — only the chrome changes.
(function () {
  const prestigeHtml = extSrc.slice(extSrc.indexOf('  getPrestigeHtml(webview) {'), extSrc.indexOf('  getShareHtml(webview) {'));
  // Instrument style: mono type, hairline rules, one amber accent.
  check('ext: prestige panel uses a monospace stack', prestigeHtml.includes('ui-monospace, SFMono-Regular, Menlo'));
  check('ext: prestige topbar is one thin line (36px, hairline bottom)',
    prestigeHtml.includes('height: 36px') && prestigeHtml.includes('border-bottom: 1px solid #1e1e1e'));
  check('ext: prestige panel has no centered max-width column',
    !prestigeHtml.includes('max-width: 1100px') && prestigeHtml.includes('main { padding: 18px 28px 48px'));
  // No rounded cards: flat areas separated by hairlines.
  check('ext: prestige panel has no border-radius rules', !prestigeHtml.includes('border-radius:'));
  check('ext: parent slots are flat areas with hairline gaps',
    prestigeHtml.includes('#slotsRow') && prestigeHtml.includes('gap: 1px') && prestigeHtml.includes('background: #1e1e1e'));
  check('ext: picker cards are flat tiles with hairline gaps',
    prestigeHtml.includes('#cards') && prestigeHtml.includes('gap: 1px'));
  check('ext: picked slot/card is an amber outline, not a border',
    prestigeHtml.includes('.parentSlot.picked { outline: 1px solid #e8b64c')
    && prestigeHtml.includes('.card.pickedA, .card.pickedB { outline: 1px solid #e8b64c'));
  // No VS Code blue buttons.
  check('ext: prestige buttons are hairline-outline, not VS Code blue',
    !prestigeHtml.includes('var(--vscode-button-background)')
    && prestigeHtml.includes('button { background: transparent; color: #d4d4d4;')
    && prestigeHtml.includes('border: 1px solid #333'));
  // No eyebrow microcopy: no uppercase letter-spaced labels, no sub-line.
  // (The .pp-grid fixed-cell rule keeps its own letter-spacing: 0.)
  check('ext: prestige panel has no uppercase letter-spaced labels',
    !prestigeHtml.includes('text-transform: uppercase')
    && !prestigeHtml.includes('letter-spacing: .12em')
    && !prestigeHtml.includes('letter-spacing: .08em'));
  check('ext: prestige topbar has no sub-line', !prestigeHtml.includes('id="subLine"'));
  // One amber accent: no green badge left.
  check('ext: no green badge left in the prestige panel', !prestigeHtml.includes('#7ee2a8'));
  // Mechanics untouched: collision, inheritance preview, confirm, picking.
  check('ext: prestige still plays the collision', prestigeHtml.includes('P.collisionFrame('));
  check('ext: prestige still shows the inheritance preview',
    prestigeHtml.includes('state.inheritBoth') && prestigeHtml.includes('state.inheritOne')
    && prestigeHtml.includes('both parents carry it')
    && prestigeHtml.includes('Anything else can still appear at its usual rare odds'));
  check('ext: prestige still asks for confirmation before fusing', prestigeHtml.includes('confirmFuseBtn'));
  check('ext: prestige still shows the offspring lineage', prestigeHtml.includes('Born from'));
})();

// 21. Starfield layer (Devon, Nov 12): the stars are a layer of the
// FRAME, not part of the planet — a .pp-frame fills its own box with
// sky (P.starfieldHtml) and the planet render inside it is star-free
// (noStars), transparent where there is no planet. The copy line in
// the fusion middle agrees with retire now.
(function () {
  const prestigeHtml = extSrc.slice(extSrc.indexOf('  getPrestigeHtml(webview) {'), extSrc.indexOf('  getShareHtml(webview) {'));
  const sysHtml = extSrc.slice(extSrc.indexOf('  getSystemHtml(webview) {'), extSrc.indexOf('  getPrestigeHtml(webview) {'));
  const shareHtml = extSrc.slice(extSrc.indexOf('  getShareHtml(webview) {'));
  const sidebarHtml = extSrc.slice(extSrc.indexOf('  getWebviewHtml(webview) {'), extSrc.indexOf('  getSystemHtml(webview) {'));
  // The copy fix: the middle line agrees with retire.
  check('ext: prestige middle line agrees with retire (no "will not survive")',
    prestigeHtml.includes('Both stay — retired, never parents again.')
    && !prestigeHtml.includes('will not survive'));
  // The component exists in all three framed panels.
  check('ext: starfield layer CSS exists in prestige, system and share panels',
    prestigeHtml.includes('.pp-frame { position: relative; }')
    && sysHtml.includes('.pp-frame { position: relative; }')
    && shareHtml.includes('.pp-frame { position: relative; }'));
  check('ext: starfield layer fills frames from their own size + cell size',
    prestigeHtml.includes('function fillStars(frameEl, sec)')
    && sysHtml.includes('function fillStars(frameEl, sec)')
    && shareHtml.includes('function fillStars(frameEl, sec)'));
  // Prestige: slots + picker tiles are frames with star-free art.
  check('ext: prestige parent slots are starfield frames with star-free art',
    prestigeHtml.includes('class="slotArt pp-frame"')
    && prestigeHtml.includes('P.render(p.planet, p.stageIdx, 10, sec, 1.0, undefined, 1, true)'));
  check('ext: prestige picker thumbs are starfield frames with star-free art',
    prestigeHtml.includes('class="thumb pp-frame"')
    && prestigeHtml.includes('P.renderCozy(p.planet, p.stageIdx, 10, 5, 1.0, 34, 19, undefined, 1, true)'));
  check('ext: prestige slot art refresh targets the planet layer, not the stars',
    prestigeHtml.includes("querySelector('.pp-planet .pp-grid')"));
  check('ext: prestige tick refreshes the starfields (twinkle)',
    prestigeHtml.includes('refreshStarfields()'));
  // System: the detail sheet is a frame with star-free art; the
  // orrery discs and Index tiles stay plain black (no layer there).
  check('ext: detail sheet is a starfield frame with star-free art',
    sysHtml.includes('id="detailArt" class="pp-frame"')
    && sysHtml.includes('P.render(planet.planet, planet.stageIdx, 10, sec, 1.0, undefined, 0.5, true)'));
  check('ext: detail tick refreshes the planet layer + the stars',
    sysHtml.includes("artEl.querySelector('.pp-planet .pp-grid')")
    && sysHtml.includes('fillStars(artEl, sec)'));
  check('ext: orrery discs and index tiles still have no starfield layer',
    !sysHtml.includes('class="disc pp-frame"') && !sysHtml.includes('class="tile pp-frame"')
    && !sysHtml.includes('class="art pp-frame"'));
  // Share: the card is a frame with star-free art; the PNG still
  // draws the starred render (a standalone image keeps its sky).
  check('ext: share card is a starfield frame with star-free art',
    shareHtml.includes('id="wrap" class="pp-frame"')
    && shareHtml.includes('P.render(state.planet, state.stageIdx, t, sec, undefined, undefined, undefined, true)'));
  check('ext: share PNG still draws the starred render',
    shareHtml.includes('P.render(state.planet, state.stageIdx,')
    && shareHtml.includes('Math.max(0, sec - stageStartSec), sec, 1.0);'));
  // Sidebar: skipped on purpose — its grid already fills the frame
  // exactly (layout() scales the cells to the wrap width).
  check('ext: sidebar pet has no starfield layer (grid already fills the frame)',
    !sidebarHtml.includes('.pp-frame') && !sidebarHtml.includes('fillStars'));
  // Collision + result frames are inline-block shrink-wrapped to the
  // grid, so their stars already fill them — no layer added there.
  check('ext: collision and result art keep their starred renders',
    prestigeHtml.includes('P.collisionFrame(fuseA.planet, fuseB.planet, state.result.offspring.planet, t, sec)')
    && prestigeHtml.includes('P.render(off.planet, off.stageIdx, 10, sec, 1.2)'));
})();

// --- 17. Grow an archived planet again (round 7, Nov 12 — Devon) ---------
// "I just started a new planet and now i cant go back to growing the
// old one. i should be able to do that from the index."
// makeCurrent revives an archived planet exactly as it was — XP,
// stage, mutations, generation — and archives the planet that was
// growing in its place. Nothing is lost; switching back is the same
// tap in reverse. The lives counter never moves on a switch: this
// is an old life resumed, not a new one.

function grownState() {
  // Gen 1 planet grown to 350 XP, then a Gen 2 planet started.
  const st = freshWithPlanet(42);
  L.applyXp(st, 350, seedSeq());
  const oldSeed = st.current.seed;
  const oldName = st.current.name;
  L.newPlanet(st, seedSeq(5000));
  return { st, oldSeed, oldName };
}

{
  const { st, oldSeed, oldName } = grownState();
  eq('r7: past holds the old planet before the switch', st.past.length, 1);
  eq('r7: lives counter is 2 before the switch', st.generation, 2);
  const res = L.makeCurrent(st, 0);
  check('r7: makeCurrent ok', res.ok === true, res.reason);
  eq('r7: current is the old planet again', st.current.seed, oldSeed);
  eq('r7: revived planet keeps its name', st.current.name, oldName);
  eq('r7: revived planet keeps its XP', st.current.xp, 350);
  eq('r7: revived planet keeps its chars', st.current.chars, 350);
  eq('r7: revived planet keeps its generation', st.current.generation, 1);
  eq('r7: lives counter does not move on a switch', st.generation, 2);
  eq('r7: the planet that was growing is archived instead', st.past.length, 1);
  eq('r7: archived replacement is the Gen 2 planet', st.past[0].generation, 2);
  eq('r7: finished count unchanged by a switch', L.finishedCount(st), 1);
  // Typing now grows the revived planet.
  L.applyXp(st, 10, seedSeq());
  eq('r7: typing grows the revived planet', st.current.chars, 360);
  eq('r7: typing grows the revived planet (xp)', st.current.xp, 360);
  // Switching back is the same tap in reverse.
  const back = L.makeCurrent(st, 0);
  check('r7: switch back ok', back.ok === true, back.reason);
  eq('r7: current is the Gen 2 planet again', st.current.generation, 2);
  eq('r7: Gen 1 planet archived with its generation intact', st.past[0].generation, 1);
  eq('r7: Gen 1 planet archived with its XP intact', st.past[0].chars, 360);
}

{
  // Mutations and terrain survive the round trip.
  const st = freshWithPlanet(42);
  st.current.mutations = ['blood-moon'];
  const oldTerrain = st.current.terrain;
  L.applyXp(st, 100, seedSeq());
  L.newPlanet(st, seedSeq(6000));
  L.makeCurrent(st, 0);
  check('r7: revived planet keeps its mutation', (st.current.mutations || []).includes('blood-moon'));
  eq('r7: revived planet keeps its terrain', st.current.terrain, oldTerrain);
}

{
  // A ring the archived planet was on stays its ring after the switch.
  const { st } = grownState();
  const placed = L.placePlanet(st, 0, st.past[0].seed, st.past[0].generation);
  check('r7: archived planet can sit on a ring', placed.ok === true, placed.reason);
  L.makeCurrent(st, 0);
  eq('r7: revived planet still on its ring', L.slotIndexForPlanet(st, st.current.seed, st.current.generation), 0);
  const resolved = L.resolveSlotPlanet(st, st.system[0]);
  check('r7: ring resolves the revived planet as current', resolved !== null && resolved.kind === 'current');
}

{
  // Generation is stamped at every birth, and archive stores the
  // planet's own generation — so a planet's birth order is never
  // rewritten by a later switch.
  const st = freshWithPlanet(42);
  eq('r7: first planet stamped Gen 1', st.current.generation, 1);
  L.newPlanet(st, seedSeq(7000));
  eq('r7: second planet stamped Gen 2', st.current.generation, 2);
  eq('r7: currentGeneration reads the stamp', L.currentGeneration(st), 2);
  L.newPlanet(st, seedSeq(8000));
  eq('r7: third planet stamped Gen 3', st.current.generation, 3);
  eq('r7: first archived record kept Gen 1', st.past[0].generation, 1);
  eq('r7: second archived record kept Gen 2', st.past[1].generation, 2);
  // An old planet without the stamp falls back to the counter.
  delete st.current.generation;
  eq('r7: unstamped planet falls back to the counter', L.currentGeneration(st), 3);
}

{
  // Guards: bad index, snapshot-less record, and no current planet.
  const { st } = grownState();
  check('r7: bad index refused', L.makeCurrent(st, 5).ok === false);
  check('r7: negative index refused', L.makeCurrent(st, -1).ok === false);
  const st2 = freshWithPlanet(42);
  L.newPlanet(st2, seedSeq(9000));
  delete st2.past[0].planet;
  check('r7: snapshot-less record refused', L.makeCurrent(st2, 0).ok === false);
  eq('r7: refused switch leaves the current planet alone', st2.current.generation, 2);
  const st3 = freshWithPlanet(42);
  L.newPlanet(st3, seedSeq(9500));
  st3.current = null;
  const res3 = L.makeCurrent(st3, 0);
  check('r7: switch with no current planet works', res3.ok === true, res3.reason);
  eq('r7: revived planet is current with no prior planet', st3.current.seed, st3.past.length === 0 ? res3.planet.seed : -1);
  eq('r7: past empty after reviving the only archived planet', st3.past.length, 0);
}

// Host wiring: the detail sheet offers the switch, the panel message
// reaches the logic, and the birth detector reads the planet's own
// generation (so a switch never toasts "was born!").
check('ext: detail sheet has a Grow this planet button', extSrc.includes('Grow this planet'));
check('ext: detail sheet button posts makeCurrent', extSrc.includes("data-action=\"makeCurrent\""));
check('ext: system message handler handles makeCurrent', extSrc.includes("msg.type === 'makeCurrent'"));
check('ext: switch suppresses the birth toast', extSrc.includes('this.lastBirthKey = this.birthKey();'));
check('ext: birthKey reads the planet generation', extSrc.includes('cur.generation'));

// --- 18. Recycle really destroys (round 8, Nov 12 — Devon) ----------------
// "i just tried destroing a planet and it didnt destroy. it was
// actively growing when i tried to do it."
// The logic check: a grown, ring-placed planet recycled twice in a
// row — the old seed must be gone everywhere (current, past, slots)
// after each recycle, and the newborn must be a genuinely new planet.
{
  const st = freshWithPlanet(42);
  L.applyXp(st, 350, seedSeq());
  const oldSeed = st.current.seed;
  const oldName = st.current.name;
  const placed = L.placePlanet(st, 0, oldSeed, 1);
  check('r8: grown planet placed on ring 0 before recycle', placed.ok === true, placed.reason);
  const rc1 = L.recycleCurrent(st, seedSeq(11000));
  check('r8: first recycle ok', rc1.ok === true, rc1.reason);
  check('r8: old planet is NOT the current planet anymore', st.current.seed !== oldSeed);
  check('r8: old planet is NOT archived (destroyed, not kept)', !st.past.some((p) => p.seed === oldSeed));
  check('r8: old planet is NOT on any ring anymore', L.slotIndexForPlanet(st, oldSeed, 1) === -1);
  check('r8: newborn is stage 0 with 0 XP', st.current.xp === 0 && L.stageForXp(st.current.xp) === 0);
  check('r8: newborn has a different name', st.current.name !== oldName);
  check('r8: newborn is Gen 2', st.current.generation === 2);
  // Recycle the newborn too (Devon's case: the new planet is stage 0,
  // an exploded debris field — recycling it must still destroy it).
  const secondSeed = st.current.seed;
  const rc2 = L.recycleCurrent(st, seedSeq(12000));
  check('r8: second recycle ok', rc2.ok === true, rc2.reason);
  check('r8: second newborn differs again', st.current.seed !== secondSeed);
  check('r8: first newborn also gone everywhere',
    st.current.seed !== oldSeed && !st.past.some((p) => p.seed === secondSeed));
  check('r8: generation is 3 after two recycles', st.generation === 3);
}

// Host wiring: the sidebar has no birth morph anymore (Devon, Nov 12
// — the morph read as a destroy animation and lagged). A newborn
// shows settled immediately; the tick's ambient motion stays. The
// share card keeps its own morph (different surface, Devon only
// flagged the sidebar) — so the trigger must appear exactly once
// in the file, in the share card.
check('ext: sidebar never replays the birth morph on a new planet',
  extSrc.split("msg.planet.seed !== state.planet.seed) || msg.stageIdx !== lastStage").length - 1 === 1);
check('ext: sidebar always shows the planet settled',
  extSrc.includes('stageStartSec = sec - 10; // settled — no birth morph'));

// --- 19. Destroy with no new planet + prompt (round 9, Nov 12) -------
// Devon: "add a second choice destroy and then ask" — the starter
// pick is only for the first planet; later births are random by
// default, but the prompt still offers the pick.
{
  const st = freshWithPlanet(42);
  L.applyXp(st, 350, seedSeq());
  const oldSeed = st.current.seed;
  const placed = L.placePlanet(st, 0, oldSeed, 1);
  check('r9: setup planet on ring 0', placed.ok === true, placed.reason);
  const starterCount = st.minerals.length;
  const dc = L.destroyCurrent(st);
  check('r9: destroy ok', dc.ok === true, dc.reason);
  check('r9: current is null after destroy', st.current === null);
  check('r9: destroyed planet NOT archived', !st.past.some((p) => p.seed === oldSeed));
  check('r9: destroyed planet NOT on any ring anymore', L.slotIndexForPlanet(st, oldSeed, 1) === -1);
  check('r9: generation does NOT move (no new life)', st.generation === 1);
  check('r9: minerals untouched by the destroy (no fed slot to consume)', st.minerals.length === starterCount + dc.minerals.length);
  check('r9: minerals yielded (mutation + bonus)', dc.minerals.length === 2 && st.minerals.some((m) => m.source === 'salvage'));
  check('r9: destroy with no current is a no-op', L.destroyCurrent(st).ok === false);
  // Birth from the empty state: random, no archive crash.
  const born = L.newPlanet(st, seedSeq(21000)).planet;
  check('r9: birth from empty state works', st.current === born && born.xp === 0);
  check('r9: birth from empty is Gen 2', st.generation === 2 && born.generation === 2);
  check('r9: birth is a plain roll (no tilt, no fed mineral)', st.fedMineral === undefined);
  // Birth with a starter terrain (the prompt's pick): pinned, like
  // the first run.
  L.destroyCurrent(st);
  const picked = L.newPlanet(st, seedSeq(22000), 'icy').planet;
  check('r9: birth with a picked terrain is that terrain', picked.terrain === 'icy', picked.terrain);
  check('r9: birth with a pick is Gen 3', st.generation === 3);
  // makeCurrent still works from the empty state (grow an old planet).
  L.applyXp(st, 150, seedSeq());
  L.archiveCurrent(st);
  L.destroyCurrent(st); // no current — no-op, state unchanged
  check('r9: setup for grow-old: one archived, none growing', st.past.length === 1 && st.current === null);
  const mc = L.makeCurrent(st, 0);
  check('r9: grow-old from empty state works', mc.ok === true && st.current === mc.planet);
  check('r9: grown-old planet keeps its XP', st.current.xp === 150);
}

// Host wiring: the salvage list offers the destroy choice, the
// post-destroy prompt offers grow / birth / birth-with-pick, the
// sidebar clears to its placeholder when nothing is growing, and the
// share panel does not crash on a planet-less push.
check('ext: salvage offers a destroy-with-no-new-planet choice',
  extSrc.includes('Destroy current planet — ${this.state.current.summary}')
  && extSrc.includes("kind: 'destroyCurrent'"));
check('ext: post-destroy prompt offers grow old / birth / birth with pick',
  extSrc.includes('async promptAfterDestroy()')
  && extSrc.includes("label: 'Grow an old planet'")
  && extSrc.includes("label: 'Birth a new planet'")
  && extSrc.includes("label: 'Birth a new planet with a starter mineral'"));
check('ext: sidebar clears to its placeholder on an empty push',
  extSrc.includes("postMessage(viewModel || { type: 'empty', destroyed: !!this.state.starterDone })")
  && extSrc.includes("if (msg.type === 'empty')")
  && extSrc.includes("gridEl.innerHTML = '';")
  && extSrc.includes("'Your planet is hatching\\u2026'")
  && extSrc.includes("'Nothing is growing \\u2014 start a new planet from the Command Palette, or grow an old one from the Index.'"));
check('ext: share panel does not crash on a planet-less push',
  extSrc.includes('if (this.sharePanel && this.state.current) this.sharePanel.webview.postMessage(this.shareViewModel());'));

// --- 20. Mutation rework (round 10, Nov 12) -------------------------------
// Sets, discovery, rank weight, and the extension wiring for the new
// system (the logic itself is covered in 12b/12d/12h above).
{
  // Sets: all three moon mutations on ONE planet is the Moon Lord.
  const p = Planet.generatePlanet(42);
  p.mutations = ['green-moon', 'blood-moon', 'big-moon'];
  eq('sets: moon lord detected', L.setsForPlanet(p).join(','), 'moon-lord');
  check('sets: moon lord message', L.setMessage(p, L.setsForPlanet(p)[0]).includes('is the Moon Lord!'));
  check('sets: birth toast names the set',
    L.birthNotifications(p).some((n) => n.includes('is the Moon Lord!')));
  const q = Planet.generatePlanet(42);
  q.mutations = ['crossed-rings', 'colored-rings', 'double-rings'];
  eq('sets: ring king detected', L.setsForPlanet(q).join(','), 'ring-king');
  const r = Planet.generatePlanet(42);
  r.mutations = ['green-moon', 'blood-moon']; // two of three is no set
  eq('sets: two of three is not a set', L.setsForPlanet(r).length, 0);
  eq('sets: a plain planet has no sets', L.setsForPlanet(Planet.generatePlanet(42)).length, 0);
  // Discovery: a mutated birth is found forever, even after the
  // planet is gone.
  st = freshWithPlanet(carrierSeed('glitch'));
  check('discovered: a glitch birth is discovered', st.discovered.includes('glitch'));
  st = freshWithPlanet(42);
  check('discovered: a glowing-oceans birth is discovered', st.discovered.includes('glowing-oceans'));
  st = L.freshState();
  eq('discovered: a fresh state has found nothing', st.discovered.length, 0);
  // Rank weight: a double-rings planet counts double toward System Rank.
  st = L.freshState();
  st.past = [
    { seed: 1, mutations: [] },
    { seed: 2, mutations: [] },
    { seed: 3, mutations: ['double-rings'] },
  ];
  eq('rank: double-rings planet counts double', L.finishedCount(st), 4);
  eq('rank: four finished planets is Rank 1', L.systemRank(st).rank, 1);
  // Mutation chance: the birth odds are still 1 in 10 (Devon's locked call).
  eq('odds: the birth chance is still 1 in 10', Planet.CONFIG.MUTATION_CHANCE, 0.007);
}

// Host wiring (round 10): the Apply command, the Mutation Index tab,
// the legendary Index tiles, the prestige % preview, and no feeding
// left anywhere.
check('ext: applyMineral is the only mineral command (no feed command)',
  extSrc.includes("'protoplanet.applyMineral'") && !extSrc.includes('feedMineral'));
check('ext: no fed slot anywhere in the host',
  !extSrc.includes('fedMineral') && !extSrc.includes('takeTilt'));
check('ext: sidebar flashes on a new mutation',
  extSrc.includes('mutationFlash') && extSrc.includes('ppFlash') && extSrc.includes('ppGlitch'));
check('ext: system panel has a Mutations tab with an Index',
  extSrc.includes("tabMutations") && extSrc.includes('renderMutations')
  && extSrc.includes('mutationIndex') && extSrc.includes('oddsText')
  && extSrc.includes('about 1 in ${Math.round(1 / Planet.CONFIG.MUTATION_CHANCE)} births'));
check('ext: Index filters and sorts by mutation',
  extSrc.includes('mutFilter') && extSrc.includes('Most mutated')
  && extSrc.includes('<select id="mutFilter">'));
check('ext: mutated Index tiles get the gold outline and the ✦ corner',
  extSrc.includes("(mutCount > 0 ? ' mutated' : '')")
  && extSrc.includes("'<div class=\"corner\">✦'") && extSrc.includes('.tile.mutated'));
check('ext: detail sheet shows mutation title cards and set title cards',
  extSrc.includes('mutCard') && extSrc.includes('setCard'));
check('ext: prestige shows the real % per parent mutation before fusing',
  extSrc.includes('mutationChance') && extSrc.includes('both parents carry it')
  && extSrc.includes('Anything else can still appear at its usual rare odds'));
check('ext: mutationChance view model carries the base chance for the panel',
  extSrc.includes('mutationChance: Planet.CONFIG.MUTATION_CHANCE')
  && extSrc.includes('state.mutationChance || 0.007'));

// --- 21. Discovery Journal + events + paste fix + archive fix (round 11, Nov 13) ---
// Journal: every planet carries its own history (born, stage, mutation,
// event, prestige, grow); events are journal-only, no visual change;
// pastes earn no XP ("block big pastes only"); the 200 archive cap is
// visible and hard — full means refuse, never silent-delete.
{
  // Journal seeding: a newborn's journal starts with its birth entry.
  // (Seed 777001 is plain — seed 42 is born with Glowing Oceans.)
  st = freshWithPlanet(777001);
  eq('journal: newborn has one born entry', st.current.journal.length, 1);
  eq('journal: born entry kind', st.current.journal[0].kind, 'born');
  check('journal: born entry names the world', st.current.journal[0].text.includes('Born —'));
  eq('journal: plain birth says no mutations', st.current.journal[0].text.includes('no mutations'), true);
  // A mutated birth names its mutations in the birth entry.
  st = freshWithPlanet(carrierSeed('glitch'));
  check('journal: mutated birth names the mutation', st.current.journal[0].text.includes('Glitch'));
  // Stage entry: crossing a threshold appends "Reached <Stage>".
  // (rng stub 0.99 so no event fires and the count stays exact.)
  st = freshWithPlanet(42);
  L.applyXp(st, 100, seedSeq(), () => 0.99);
  eq('journal: stage entry appended', st.current.journal.length, 2);
  eq('journal: stage entry kind', st.current.journal[1].kind, 'stage');
  eq('journal: stage entry names Accretion', st.current.journal[1].text, 'Reached Accretion');
  // No stage change, no stage entry.
  st = freshWithPlanet(42);
  L.applyXp(st, 50, seedSeq());
  eq('journal: no stage entry without a stage-up', st.current.journal.length, 1);
  // Events: rng stub 0.0 fires (0.0 < 0.25), 0.99 does not.
  st = freshWithPlanet(42);
  const evRes = L.applyXp(st, 100, seedSeq(), () => 0.0);
  check('journal: event fires on a low roll', evRes.event !== null);
  eq('journal: event entry kind', st.current.journal[2].kind, 'event');
  check('journal: event entry has a title', typeof st.current.journal[2].title === 'string' && st.current.journal[2].title.length > 0);
  st = freshWithPlanet(42);
  const noEv = L.applyXp(st, 100, seedSeq(), () => 0.99);
  eq('journal: no event on a high roll', noEv.event, null);
  eq('journal: no event entry on a high roll', st.current.journal.length, 2);
  // No repeats: two forced events on one planet have different titles.
  st = freshWithPlanet(42);
  const e1 = L.applyXp(st, 100, seedSeq(), () => 0.0);
  const e2 = L.applyXp(st, 200, seedSeq(), () => 0.0);
  check('journal: two forced events differ', e1.event && e2.event && e1.event.title !== e2.event.title);
  // Mutation entry: a landed mineral writes "Gained <Mutation>".
  st = freshWithPlanet(42);
  st.current.mutations = [];
  const gm = L.makeMineral(st, { family: 'moon', mutation: 'green-moon', source: 'salvage' });
  st.minerals.push(gm);
  const okM = L.attemptMutation(st, gm.id, () => 0.1);
  eq('journal: mutation applied', okM.success, true);
  check('journal: mutation entry appended', st.current.journal.some((e) => e.kind === 'mutation' && e.text.includes('Green Moon')));
  // Prestige entries: parents record it, offspring is born of them.
  st = prestigeReadyState();
  const pres = L.prestige(st, { kind: 'past', index: 0 }, { kind: 'current', index: -1 }, seedSeq(9000));
  eq('journal: prestige ok', pres.ok, true);
  check('journal: offspring born of its parents', pres.planet.journal.some((e) => e.kind === 'prestige' && e.text.includes('Born of')));
  check('journal: archived parent recorded it', st.past.some((p) => (p.planet.journal || []).some((e) => e.kind === 'prestige' && e.text === 'Became a parent')));
  // Grow entry: growing an old planet again writes "Grew again".
  st = freshWithPlanet(42);
  L.applyXp(st, 500, seedSeq());
  L.newPlanet(st, seedSeq(8000));
  const grow = L.makeCurrent(st, 0);
  eq('journal: grow ok', grow.ok, true);
  check('journal: grow entry appended', grow.planet.journal.some((e) => e.kind === 'grow' && e.text === 'Grew again'));
  // Migration: an old save without journals gets a seeded birth entry.
  st = freshWithPlanet(42);
  L.applyXp(st, 500, seedSeq());
  L.newPlanet(st, seedSeq(8000));
  delete st.current.journal;
  delete st.past[0].journal;
  delete st.past[0].planet.journal;
  const loaded = L.deserializeState(L.serializeState(st));
  check('journal: migration seeds the current planet', loaded.current.journal.length === 1 && loaded.current.journal[0].kind === 'born');
  check('journal: migration seeds archived snapshots', loaded.past[0].planet.journal.length === 1 && loaded.past[0].planet.journal[0].kind === 'born');
}
{
  // Archive cap (round 11): 200 is visible and hard — full means
  // refuse, never silent-delete. Fill the archive to exactly 200.
  st = freshWithPlanet(42);
  const firstSeed = st.current.seed;
  for (let i = 0; i < 200; i++) {
    L.applyXp(st, 2500, seedSeq(30000 + i * 100));
    const r = L.newPlanet(st, seedSeq(40000 + i * 100));
    eq('archive: birth ' + i + ' ok', r.ok, true);
  }
  eq('archive: past holds exactly 200', st.past.length, 200);
  check('archive: the oldest planet is still there (no silent delete)',
    st.past.some((p) => p.seed === firstSeed));
  eq('archive: archiveCurrent refuses when full', L.archiveCurrent(st).ok, false);
  eq('archive: refusal reason', L.archiveCurrent(st).reason, 'archive full');
  const cur = st.current;
  const refused = L.newPlanet(st, seedSeq(99999));
  eq('archive: newPlanet refuses when full', refused.ok, false);
  eq('archive: newPlanet refusal reason', refused.reason, 'archive full');
  eq('archive: refused birth keeps the current planet', st.current, cur);
  eq('archive: makeCurrent refuses when full', L.makeCurrent(st, 0).ok, false);
  eq('archive: makeCurrent refusal reason', L.makeCurrent(st, 0).reason, 'archive full');
  eq('archive: hatchFromSeed refuses when full', L.hatchFromSeed(st, 12345).ok, false);
  // Prestige refuses too (two Civilization parents are available) —
  // and the refusal mutates nothing: the parents stay eligible.
  const presFull = L.prestige(st, { kind: 'past', index: 0 }, { kind: 'past', index: 1 }, seedSeq(88888));
  eq('archive: prestige refuses when full', presFull.ok, false);
  eq('archive: refused prestige leaves parents eligible', st.past[0].usedAsParent, false);
  // Freeing a slot lets births work again.
  const salv = L.salvageArchived(st, 0);
  eq('archive: salvage frees a slot', salv.ok, true);
  eq('archive: past is 199 after salvage', st.past.length, 199);
  const reborn = L.newPlanet(st, seedSeq(77777));
  eq('archive: birth works again after freeing a slot', reborn.ok, true);
  eq('archive: past back to 200', st.past.length, 200);
}

// Host wiring (round 11): the journal renders on the detail sheet,
// the Index shows N/200 and a one-line journal per tile, the
// archive-full toast fires on every refused birth/switch/fuse, an
// event toasts once, and an archived planet can be salvaged from its
// detail sheet to free a slot.
check('ext: detail sheet renders the journal',
  extSrc.includes('Journal</h3>') && extSrc.includes('journalHtml') && extSrc.includes('jentry'));
check('ext: Index header shows the archive count',
  extSrc.includes('archiveCount') && extSrc.includes('Archive ') && extSrc.includes('archiveLimit'));
check('ext: Index tiles show a one-line journal',
  extSrc.includes('journalLine') && extSrc.includes('jline'));
check('ext: view model carries the journal and the archive count',
  extSrc.includes('journal: (record.journal') && extSrc.includes('archiveCount: (this.state.past'));
check('ext: archive-full toast on refused births',
  extSrc.includes('notifyArchiveFull') && extSrc.includes('Archive is full') && extSrc.includes('salvage an archived planet'));
check('ext: event toasts once on a stage-up event',
  extSrc.includes('Something happened on') && extSrc.includes('res.event'));
check('ext: archived planet can be salvaged from its detail sheet',
  extSrc.includes('data-action="salvage"') && extSrc.includes("type: 'salvage'"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n- ' + failures.join('\n- '));
  process.exit(1);
}
