// petLogic.js — Piece 2: the PURE logic of the Protoplanet extension.
//
// No `vscode` import here: every function in this file runs in plain Node
// (see test-pet.js). extension.js does the VS Code wiring (events,
// webview, status bar, globalState) and calls into here. Keeping the
// logic separate is what makes it testable without launching VS Code.
//
// The model:
//   * Typing is XP: 1 inserted character = 1 XP (for now).
//   * XP grows the current planet through the 7 lifecycle stages
//     (Shattered birth -> ... -> Civilization), same stages as
//     lifecycle.py / planet.js. Thresholds live in CONFIG below.
//   * There is NO automatic rebirth (cut Nov 12): past the last stage
//     the planet just keeps gaining XP indefinitely. A new planet only
//     ever starts when the player asks for one (New planet command,
//     recycle, prestige) — the old one is archived to the collection
//     record then. A maxed planet (Civilization, 2200+ XP) shows an
//     orange XP bar and gets a one-time prompt offering a new planet.

'use strict';

const Planet = require('./planet.js');

// ---------------------------------------------------------------------------
// CONFIG — every tunable number for piece 2 lives here, in one place.
// ---------------------------------------------------------------------------
const CONFIG = {
  // XP_THRESHOLDS[i] = total XP needed to REACH stage i (0 = Dust cloud).
  // First evolution is fast (~100 chars) so you see it quickly; later
  // stages take longer — a Civilization planet is a few days of real
  // typing. All numbers are tunable here.
  XP_THRESHOLDS: [0, 100, 300, 600, 1000, 1500, 2200],

  // No automatic rebirth (cut Nov 12): there is no XP total that
  // archives the planet on its own. XP past the last stage just keeps
  // accumulating, and a new planet only starts on demand.

  // Starter terrains offered on first run (first planet only).
  STARTER_TERRAINS: ['icy', 'lava', 'jungle', 'rocky', 'ocean'],

  // How many finished planets the collection record keeps (round 11
  // — Devon, Nov 13): 200 is generous, and the cap is now VISIBLE
  // (the Index shows N/200) and HARD — when it is full, archiving
  // refuses instead of silently deleting the oldest planet. The
  // player frees a slot by salvaging an archived planet.
  PAST_LIMIT: 200,

  // Paste rule (round 11 — Devon picked "block big pastes only"):
  // a single content change whose inserted text is longer than this
  // many characters earns no XP. Typing (1 char), auto-close pairs
  // (2), and autocomplete words all still count; a pasted file does
  // not. A pasted single short line can still slip through — it
  // can't jump a stage, accepted tradeoff of the rule.
  PASTE_CHAR_LIMIT: 50,

  // Discovery Journal events (round 11): on a stage-up, a planet
  // has this chance of a rare story event — a journal entry only,
  // NO visual change, so an event never ruins a planet someone
  // loves the look of. One event max per stage-up, and a planet
  // never repeats an event it already had.
  EVENT_CHANCE: 0.25,
  EVENTS: [
    { id: 'meteor-impact', title: 'Meteor Impact', text: 'A meteor struck the northern plains, leaving a crater that will outlast the civilization.' },
    { id: 'strange-signal', title: 'Strange Signal', text: 'A strange signal rose from the southern hemisphere — no one knows what sent it.' },
    { id: 'crystal-bloom', title: 'Crystal Bloom', text: 'Luminous crystals bloomed across the surface overnight.' },
    { id: 'solar-storm', title: 'Solar Storm', text: 'A solar storm painted the sky with light for three nights.' },
    { id: 'ancient-ruins', title: 'Ancient Ruins', text: 'Explorers found ruins older than the planet\u2019s own oceans.' },
    { id: 'comet-passing', title: 'Comet Passing', text: 'A comet passed close enough to light the night side.' },
    { id: 'aurora', title: 'Aurora', text: 'Auroras rippled over the poles, visible from orbit.' },
    { id: 'deep-tremor', title: 'Deep Tremor', text: 'A deep tremor reshaped the coastline.' },
  ],

  // How often the pet's state is written to disk while typing (ms).
  // Saves also happen immediately on stage change / new planet, so
  // nothing important is ever lost.
  SAVE_DEBOUNCE_MS: 3000,

  // --- Minerals, salvage/recycle, prestige (step 2, Nov 11) -----------
  // A mineral IS a mutation, bottled: a mutated planet yields a
  // mineral OF its mutation when destroyed. Spend it to try to put
  // that mutation on the planet you love — right now, same planet,
  // same moment (round 10, Nov 12 — Devon's call: feeding a mineral
  // to tilt the NEXT planet's birth was confusing and clunky, cause
  // on one planet, effect on another, later. Feeding is gone.)
  MINERAL_FAMILIES: ['moon', 'rings', 'glow', 'storm', 'sky', 'weird'],

  // The mutate attempt (round 10): spend a mineral, coin flip — it
  // takes hold or it fizzles and the mineral is gone. One knob.
  MUTATE_CHANCE: 0.5,

  // Sets (round 10): a whole mutation family on ONE planet names
  // it. The set is the planet's title, not a separate reward.
  SETS: [
    { id: 'moon-lord', name: 'Moon Lord', required: ['green-moon', 'blood-moon', 'big-moon'] },
    { id: 'ring-king', name: 'Ring King', required: ['crossed-rings', 'colored-rings', 'double-rings'] },
  ],

  // Prestige inheritance (Devon's call, Nov 12): a parent mutation
  // passes to the offspring at a REAL chance — 50% if one parent
  // has it, 75% if both. Inheritance is genetics, not a lottery
  // ticket: the old x2/x3 multipliers on the 0.7% base only gave
  // 1.4%/2.1%, barely better than random, which made fusing for a
  // mutation feel pointless. Everything neither parent has still
  // rolls at the base chance.
  PRESTIGE_INHERIT_CHANCE_ONE: 0.5,
  PRESTIGE_INHERIT_CHANCE_BOTH: 0.75,

  // Parent fate (Devon's call, accepted retire for now): parents STAY
  // in the collection, but each planet can only be a parent ONCE.
  // Flip to true to destroy the parents instead (merge realism) —
  // the offspring's record always stores its parents (lineage).
  PRESTIGE_CONSUMES_PARENTS: false,

  // A planet can prestige once it reached Civilization (stage 6,
  // 2200 XP). "Reached" — a maxed planet that kept growing past
  // 2200 counts too; Civilization is the final stage.
  PRESTIGE_MIN_CHARS: 2200,

  // --- Solar system (step 4, Nov 11) ------------------------------------
  // The collection is capped at PAST_LIMIT (round 11 — the cap is
  // visible and hard now, never a silent delete); the solar system
  // only DISPLAYS a limited number of planets — one per orbit ring. The player picks
  // which planets occupy the rings. A "System Rank" rises as the player
  // grows finished planets; each rank unlocks +1 ring. Locked rings
  // stay visible (dashed, with their unlock requirement) — they are
  // the progression UI, not a hidden cap. No currency yet (Genshin
  // Trust Rank style, not a shop).
  SYSTEM_BASE_RINGS: 4, // rings at Rank 0
  SYSTEM_FINISHED_PER_RANK: 3, // finished planets per +1 ring
  SYSTEM_MAX_RINGS: 12, // the orrery gets unreadable past this; retune if needed

  // The one free starter mineral, granted on first run (crystal —
  // a random glow-family mutation when spent on your planet).
  STARTER_MINERAL: { kind: 'crystal', family: 'glow', mutation: null, source: 'starter' },
};

// ---------------------------------------------------------------------------
// Counting typed characters (from a VS Code onDidChangeTextDocument event).
// ---------------------------------------------------------------------------

// Document schemes we count typing in. Everything else (output panels,
// git views, settings UI, ...) is not "coding" and earns no XP.
const COUNTED_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell']);

function shouldCountDocument(scheme) {
  return COUNTED_SCHEMES.has(scheme);
}

// Count net inserted characters from one event's contentChanges.
// Each change: text.length chars were inserted, rangeLength chars were
// removed. Only the positive difference counts (deletions never grow
// the planet, and they never shrink it either).
// Paste rule (round 11 — Devon picked "block big pastes only"): a
// single change that looks like a paste earns nothing — its inserted
// text contains a newline (and is longer than 1 char, so the Enter
// key itself still counts 1 XP) or is longer than PASTE_CHAR_LIMIT.
// Typing, auto-close pairs, and autocomplete words all still count;
// a pasted file does not. The check is on c.text (what was inserted),
// not the net difference — a paste-over-selection has big text with
// a nonzero rangeLength.
function countInsertedChars(contentChanges) {
  let n = 0;
  for (const c of contentChanges) {
    // .length counts UTF-16 units, same as VS Code's offsets — so an
    // emoji counts as 2 XP. Harmless, and consistent with rangeLength.
    const text = c.text || '';
    if (text.length > 1 && text.includes('\n')) continue; // multi-line insert = paste
    if (text.length > CONFIG.PASTE_CHAR_LIMIT) continue; // long insert = paste
    const inserted = text.length - c.rangeLength;
    if (inserted > 0) n += inserted;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Stages and progress (pure functions of total XP).
// ---------------------------------------------------------------------------

// Which lifecycle stage (0-6) an XP total is in.
function stageForXp(xp) {
  const t = CONFIG.XP_THRESHOLDS;
  let idx = 0;
  for (let i = 0; i < t.length; i++) {
    if (xp >= t[i]) idx = i;
    else break;
  }
  return idx;
}

// The display stage for the Solar System panel / Archive (step 4):
// the planet is shown at its stage CAPPED at Civilization (stage 6).
// Civilization is the final stage (End was cut Nov 12), so the cap
// is now a no-op safeguard — the true stage never exceeds it — but
// the panel keeps going through this function so display logic
// stays in one place.
const DISPLAY_STAGE_MAX = Planet.STAGES.findIndex((s) => s.name === 'Civilization');
function displayStageForXp(xp) {
  return Math.min(stageForXp(xp), DISPLAY_STAGE_MAX);
}

// Maxed = reached Civilization (stage 6, 2200+ XP) — fully evolved,
// Pokechi-style: the XP bar turns orange from here on. Civilization
// is the last planet stage (End was cut Nov 12); past it there is
// no next stage at all (no auto-rebirth).
function isMaxed(xp) {
  return stageForXp(xp) >= DISPLAY_STAGE_MAX;
}

// Everything the UI needs to show progress for an XP total.
function stageInfo(xp) {
  const idx = stageForXp(xp);
  const t = CONFIG.XP_THRESHOLDS;
  const stageStart = t[idx];
  const nextXp = idx + 1 < t.length ? t[idx + 1] : null; // null at Civilization: no next stage
  const st = Planet.STAGES[idx];
  return {
    stageIdx: idx,
    name: st.name,
    desc: st.desc,
    stageStart, // XP where this stage began
    nextXp, // XP where the next stage happens, null at Civilization (final stage)
    inStage: xp - stageStart, // XP earned inside this stage
    span: nextXp === null ? null : nextXp - stageStart, // XP this stage takes in total
    isMax: isMaxed(xp), // fully evolved (Civilization+) — orange XP bar
  };
}

// The sidebar XP bar (round 6, Nov 12 — Devon): progress INSIDE the
// current stage — the bar resets at every stage-up and shows the new
// goal, not the cumulative total. 292 XP (stage 1, Accretion) is
// "192 / 200"; 350 XP (stage 2, Molten) is "50 / 300". At
// Civilization there is no next stage: fill is full and the label is
// the MAX line, unchanged (total XP still shows there). The sidebar
// webview and the status bar both read these numbers from the view
// model; the detail sheet keeps the TOTAL ("Grown from N characters").
function xpBar(xp) {
  const info = stageInfo(xp);
  if (info.isMax) return { inStage: info.inStage, span: null, fill: 1, isMax: true, label: `XP ${xp} · MAX — fully evolved` };
  return { inStage: info.inStage, span: info.span, fill: info.inStage / info.span, isMax: false, label: `XP ${info.inStage} / ${info.span}` };
}

// ---------------------------------------------------------------------------
// Notifications (round 6, Nov 12 — Devon): plain, short toasts. The
// host (extension.js) shows them with showInformationMessage; these
// pure builders are what the tests assert, so the wording lives here
// in one place. Stage-up fires on the stage crossing (edge-triggered
// in applyXp's caller); birth/mutation fire once at birth, for every
// birth path — the host detects births by planet identity, so no path
// can miss them and a reload never replays one.
// ---------------------------------------------------------------------------

// "GJ-364c reached Molten!"
function stageUpMessage(planet, stageIdx) {
  const stage = Planet.STAGES[stageIdx] || Planet.STAGES[0];
  return `${nameForPlanet(planet)} reached ${stage.name}!`;
}

// "GJ-364c was born!"
function hatchMessage(planet) {
  return `${nameForPlanet(planet)} was born!`;
}

// "GJ-364c was born with a mutation: Blood Moon!" — or with two,
// "…was born with mutations: Blood Moon + Glitch!". Null when the
// planet was born plain.
function mutationMessage(planet) {
  const ids = planet.mutations || [];
  if (ids.length === 0) return null;
  const names = ids.map((id) => (Planet.mutationDef(id) || { name: id }).name);
  return names.length === 1
    ? `${nameForPlanet(planet)} was born with a mutation: ${names[0]}!`
    : `${nameForPlanet(planet)} was born with mutations: ${names.join(' + ')}!`;
}

// Everything a newborn planet earns: always the birth toast, plus the
// mutation toast when it was born with one, plus a set toast when the
// birth completes a whole family on one planet ("GJ-364c is the Moon
// Lord!"). A seed-hatched planet never carries mutations, so it earns
// only the birth toast.
function birthNotifications(planet) {
  const msgs = [hatchMessage(planet)];
  const m = mutationMessage(planet);
  if (m) msgs.push(m);
  for (const setId of setsForPlanet(planet)) msgs.push(setMessage(planet, setId));
  return msgs;
}

// "GJ-364c is the Moon Lord!" — the planet completed a whole mutation
// family (sets live in CONFIG.SETS). Null for an unknown set id.
function setMessage(planet, setId) {
  const def = setDef(setId);
  if (!def) return null;
  return `${nameForPlanet(planet)} is the ${def.name}!`;
}

// ---------------------------------------------------------------------------
// Planets and state.
// ---------------------------------------------------------------------------

function randomSeed() {
  return Math.floor(Math.random() * 1000000000);
}

// A fresh planet: the seeded traits from planet.js plus XP tracking.
// xp and chars are the same number in v1 (1 char = 1 XP); chars is
// kept as its own field because later pieces add XP that isn't typed
// (minerals, piece 5) — "grown from N characters" stays honest.
// `tilt` (optional) biases the birth roll — prestige inheritance
// only (see prestigeTilt()); plain births pass undefined.
// `usedAsParent` tracks the one-time-parent rule; `parents` is the
// lineage (prestige offspring only) — always stored, so the family
// tree stays visible even if parent-fate flips to destroy.
// `takenNames` (optional Set) is the birth-time uniqueness layer:
// when a planet is born, if its base name is already used by another
// planet in the player's collection, the name is nudged (number /
// letter, seed-derived) until it is unique. The final name is stored
// on the record and never changes after birth. When no set is passed
// (tests, one-off rolls), the planet keeps its base name.
function makePlanet(seed, starterTerrain, tilt, takenNames, generation) {
  const p = Planet.generatePlanet(seed, starterTerrain, tilt);
  if (takenNames) p.name = uniquePlanetName(p.name, seed, takenNames);
  p.xp = 0;
  p.chars = 0;
  p.usedAsParent = false;
  p.parents = null;
  // The planet carries its own birth-order generation (round 7):
  // "Gen 1" is which life this planet is, and it must never change —
  // not when the planet is archived, and not when it is grown again
  // later. state.generation is the lives counter; a planet born as
  // Gen 2 stays Gen 2 even if an older planet is reactivated first.
  // Older planets (born before this stamp) have no field — callers
  // read through currentGeneration() instead, which falls back to
  // state.generation.
  if (Number.isInteger(generation)) p.generation = generation;
  seedBornJournal(p);
  return p;
}

// The living planet's generation: its own stamped field when it has
// one, state.generation otherwise (old saves, where the current
// planet was born as the latest life — the fallback is exactly
// right for those). Every read of "the current planet's generation"
// goes through here, so a reactivated planet keeps its generation
// instead of inheriting the lives counter.
function currentGeneration(state) {
  if (state.current && Number.isInteger(state.current.generation)) return state.current.generation;
  return state.generation;
}

// ---------------------------------------------------------------------------
// Discovery Journal (round 11) — every planet's own history.
// A journal is an array of { t, kind, text } on the planet record
// (event entries also carry `title`): born, stage, mutation, event,
// prestige, grow. It travels with the planet — the archived snapshot
// carries it, so a planet grown again keeps its whole story. Events
// are journal-only: no visual change, ever, in v1.
// ---------------------------------------------------------------------------

function journalEntry(kind, text, title) {
  const e = { t: Date.now(), kind, text };
  if (title) e.title = title;
  return e;
}

function addJournal(planet, kind, text, title) {
  if (!planet) return;
  if (!Array.isArray(planet.journal)) planet.journal = [];
  planet.journal.push(journalEntry(kind, text, title));
}

function bornJournalText(planet) {
  const terrain = planet.terrainLabel || planet.terrain || 'unknown';
  const names = (planet.mutations || []).map((id) => {
    const def = Planet.mutationDef(id);
    return def ? def.name : id;
  });
  return `Born — ${terrain} world` + (names.length > 0 ? ` · born with ${names.join(', ')}` : ' · no mutations');
}

// Seed a newborn's journal with its birth entry. Called by makePlanet
// and makeSeedPlanet (the seed hatch builds its planet directly).
function seedBornJournal(planet) {
  planet.journal = [journalEntry('born', bornJournalText(planet))];
}

// Roll a rare story event for a stage-up: EVENT_CHANCE, one max per
// stage-up, never a repeat on the same planet. Returns the event def
// or null. rng is injectable for tests.
function rollEvent(planet, rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  if (roll() >= CONFIG.EVENT_CHANCE) return null;
  const seen = new Set((planet.journal || []).filter((e) => e.kind === 'event').map((e) => e.title));
  const fresh = CONFIG.EVENTS.filter((ev) => !seen.has(ev.title));
  if (fresh.length === 0) return null;
  return fresh[Math.trunc(roll() * fresh.length)];
}

// A planet's name: stored on the record when it was born (step 4),
// or derived from its seed for older records that predate names —
// the name is a function of the seed, so an old planet's name is
// exactly the name it would have been born with.
function nameForPlanet(planet) {
  if (!planet) return '';
  return planet.name || Planet.generatePlanetName(planet.seed || 0);
}

// Names already in use in this collection: the current planet's name
// plus every archived planet's name (old records without a stored
// name derive it from their seed). A destroyed/recycled planet is
// NOT in the set — it's gone, so its name is free again. (At a
// recycle birth the destroyed planet is still `state.current`, so
// its name is conservatively counted once more — harmless: the new
// planet just won't reuse it.)
function takenNamesFor(state) {
  const taken = new Set();
  if (state.current) taken.add(nameForPlanet(state.current));
  for (const p of (state.past || [])) taken.add(nameForPlanet(p));
  return taken;
}

// Birth-time uniqueness: if `baseName` is already taken, nudge the
// catalog number/letter deterministically (seed-derived step) until
// the name is free. The walk stays in the same catalog first —
// "WASP-12b" taken becomes "WASP-12e", not a different catalog —
// and only moves to the next catalog if a whole one is full
// (essentially impossible: the smallest catalog still has 100
// names). Deterministic: same seed + same taken set -> same name.
// Names that aren't in catalog form (a stored custom name) are left
// alone — the layer only knows how to nudge catalog names.
function uniquePlanetName(baseName, seed, taken) {
  if (!taken || !taken.has(baseName)) return baseName;
  const parsed = Planet.parseCatalogName(baseName);
  if (!parsed) return baseName;
  const cats = Planet.CONFIG.NAME_CATALOGS;
  const letters = Planet.CONFIG.NAME_LETTERS;
  const step = 1 + Math.trunc(Planet.mulberry32((seed ^ 0x5EEDF00D) >>> 0)() * 7);
  // Walk catalogs in table order starting from the base name's
  // catalog; inside a catalog, walk the (number, letter) space with
  // the seed-derived step. The total space is ~1.3M names, so this
  // always finds a free one long before the guard.
  let catIdx = cats.indexOf(parsed.catalog);
  let idx = (parsed.num - parsed.catalog.min) * letters.length + parsed.letterIdx;
  for (let guard = 0; guard < 100000; guard++) {
    const cat = cats[catIdx];
    const size = (cat.max - cat.min + 1) * letters.length;
    idx = (idx + step) % size;
    const num = cat.min + Math.trunc(idx / letters.length);
    const candidate = Planet.formatCatalogName(cat, num, letters[idx % letters.length]);
    if (!taken.has(candidate)) return candidate;
    // A full lap of this catalog (size steps) with nothing free:
    // try the next catalog from its start.
    if ((guard + 1) % size === 0) {
      catIdx = (catIdx + 1) % cats.length;
      idx = -step;
    }
  }
  return baseName; // unreachable in practice — every catalog is huge
}

function freshState() {
  return {
    version: 1,
    starterDone: false, // has the first-run terrain pick been done?
    generation: 1, // how many planet lives so far (new planets: manual, recycle, prestige)
    current: null, // the living planet (makePlanet result), or null
    past: [], // finished planets: {seed, name, terrain, terrainLabel, summary, chars, generation, archivedAt, mutations, parents, usedAsParent, planet}
    // Step 4: the solar system — one slot per orbit ring. A slot is
    // null (empty) or { seed, generation } identifying the planet on
    // that ring. Planets are looked up by seed+generation, so a slot
    // survives the planet moving between current and archived.
    system: [null, null, null, null],
    // Step 2: the mineral inventory.
    minerals: [], // [{ id, kind, family, mutation, source }]
    mineralSeq: 0, // counter for mineral ids
    starterMineralGranted: false,
    // Round 10: the Mutation Index — every mutation id ever seen on
    // a planet you grew (birth roll, successful apply, prestige
    // offspring). A mutation is "found" forever, even after the
    // planet that carried it is destroyed.
    discovered: [], // [mutationId, ...]
  };
}

// First run: hatch the first planet, optionally biased by the starter
// terrain the user picked (undefined = fully random). Grants the one
// free starter mineral (crystal — a random glow-family mutation when
// spent on your planet). The birth is recorded in the Mutation Index.
function startFirstPlanet(state, seed, starterTerrain) {
  state.current = makePlanet(seed, starterTerrain, undefined, takenNamesFor(state), state.generation);
  recordDiscovery(state, state.current);
  state.starterDone = true;
  grantStarterMineral(state);
  return state.current;
}

// ---------------------------------------------------------------------------
// Minerals (step 2) — the inventory and the mutate attempt (round 10).
// A mineral is { id, kind, family, mutation, source }:
//   * family: one of CONFIG.MINERAL_FAMILIES (moon/rings/glow/...).
//   * mutation: the mutation id it carries, or null for a plain family
//     mineral. A mutated planet yields a mineral OF its mutation.
//   * source: 'starter' | 'salvage' | 'prestige' (where it came from).
// A mineral IS the mutation, bottled: spend it to try to put that
// mutation on the planet you love — the attempt below. Feeding (tilt
// the NEXT planet's birth) was cut in round 10: cause on one planet,
// effect on another, later, was the clunky part.
// ---------------------------------------------------------------------------

function mineralName(mineral) {
  if (!mineral) return '';
  if (mineral.mutation) {
    const def = Planet.mutationDef(mineral.mutation);
    return `${def ? def.name : mineral.mutation} mineral`;
  }
  if (mineral.kind === 'crystal') return 'Crystal mineral';
  return `${mineral.family} mineral`;
}

// Plain words for the UI: what does spending this mineral try to do?
function mineralApplyText(mineral) {
  if (!mineral) return '';
  if (mineral.mutation) {
    const def = Planet.mutationDef(mineral.mutation);
    return `try to put ${def ? def.name : mineral.mutation} on your planet (coin flip)`;
  }
  return `try a random ${mineral.family} mutation on your planet (coin flip)`;
}

function makeMineral(state, spec) {
  state.mineralSeq += 1;
  return {
    id: `min-${state.mineralSeq}`,
    kind: spec.kind || (spec.mutation ? 'mutation' : 'family'),
    family: spec.family,
    mutation: spec.mutation || null,
    source: spec.source || 'salvage',
  };
}

// The one free starter mineral (crystal). Once per state, ever.
function grantStarterMineral(state) {
  if (state.starterMineralGranted) return null;
  state.starterMineralGranted = true;
  const m = makeMineral(state, CONFIG.STARTER_MINERAL);
  state.minerals.push(m);
  return m;
}

// The Mutation Index (round 10): record every mutation on this planet
// as discovered — "found" forever, even after the planet is destroyed.
// A seed-hatched planet has no mutations, so it records nothing.
function recordDiscovery(state, planet) {
  if (!planet) return;
  if (!Array.isArray(state.discovered)) state.discovered = [];
  for (const id of (planet.mutations || [])) {
    if (!state.discovered.includes(id)) state.discovered.push(id);
  }
}

// The sets a planet completes: every required mutation of a family on
// ONE planet. A planet with two green moons still only counts once —
// the set is about the family, not the count.
function setDef(setId) {
  return CONFIG.SETS.find((s) => s.id === setId) || null;
}

function setsForPlanet(planet) {
  const muts = new Set(planet ? planet.mutations || [] : []);
  return CONFIG.SETS.filter((s) => s.required.every((id) => muts.has(id))).map((s) => s.id);
}

// Spend a mineral to try to put its mutation on the CURRENT planet
// (round 10 — the mineral IS the mutation). The mineral is consumed
// whether the attempt works or not — the price is the mineral, and
// the mineral came from destroying a planet that had the mutation.
//   * A mutation mineral tries THAT mutation.
//   * A family mineral tries a RANDOM mutation in its family that the
//     planet doesn't already have.
//   * Blocked (mineral NOT consumed): the planet already has that
//     mutation, or owns every mutation in the family.
// `rng` is the coin flip (defaults to Math.random; tests pass a fixed
// one). The visuals use a SEEDED rng (seed + mutation), so the same
// apply always looks the same way. Returns { ok, success,
// mutationId, mutationName, setsCompleted } — setsCompleted lists the
// set ids the planet completed with this mutation, if any.
function attemptMutation(state, mineralId, rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  if (!state.current) return { ok: false, reason: 'no current planet' };
  const idx = (state.minerals || []).findIndex((m) => m.id === mineralId);
  if (idx < 0) return { ok: false, reason: 'no such mineral' };
  const mineral = state.minerals[idx];
  const owned = new Set(state.current.mutations || []);
  let targetId = null;
  if (mineral.mutation) {
    if (owned.has(mineral.mutation)) return { ok: false, reason: 'planet already has it' };
    targetId = mineral.mutation;
  } else {
    const candidates = Planet.CONFIG.MUTATIONS
      .filter((m) => (m.tags || []).includes(mineral.family) && !owned.has(m.id))
      .map((m) => m.id);
    if (candidates.length === 0) return { ok: false, reason: 'planet already has them all' };
    targetId = candidates[Math.trunc(roll() * candidates.length)];
  }
  // The mineral is spent — success or fizzle, it's gone.
  state.minerals.splice(idx, 1);
  const def = Planet.mutationDef(targetId);
  if (roll() >= CONFIG.MUTATE_CHANCE) {
    return { ok: true, success: false, mutationId: targetId, mutationName: def ? def.name : targetId, setsCompleted: [] };
  }
  const setsBefore = new Set(setsForPlanet(state.current));
  state.current.mutations = [...(state.current.mutations || []), targetId];
  Planet.applyMutationToPlanet(state.current, targetId, Planet.applyRng(state.current.seed, targetId));
  recordDiscovery(state, state.current);
  addJournal(state.current, 'mutation', `Gained ${def ? def.name : targetId}`);
  const setsCompleted = setsForPlanet(state.current).filter((id) => !setsBefore.has(id));
  return { ok: true, success: true, mutationId: targetId, mutationName: def ? def.name : targetId, setsCompleted };
}

// The prestige tilt (round 10): the ONLY tilt left. A fed mineral no
// longer exists — the offspring's birth roll is tilted by the
// parents' mutations (inheritance) and nothing else. Returns null
// when there is nothing to tilt (plain birth roll).
function prestigeTilt(extraBoosts) {
  const boosts = {};
  if (extraBoosts) {
    for (const [id, mult] of Object.entries(extraBoosts)) {
      boosts[id] = (boosts[id] || 1) * mult;
    }
  }
  return Object.keys(boosts).length > 0 ? { boosts } : null;
}

// What the status bar / pet window shows about minerals.
function mineralSummary(state) {
  const byFamily = {};
  for (const f of CONFIG.MINERAL_FAMILIES) byFamily[f] = 0;
  for (const m of state.minerals || []) byFamily[m.family] = (byFamily[m.family] || 0) + 1;
  return {
    total: (state.minerals || []).length,
    byFamily,
  };
}

// ---------------------------------------------------------------------------
// Salvage / recycle (step 2) — destroying planets for minerals.
// ---------------------------------------------------------------------------

// What a destroyed planet yields. One mineral per mutation it carries
// (each carrying that mutation — the mineral remembers where it came
// from), PLUS one extra plain mineral when it was mutated at all
// (round 10 perk: a mutated planet is worth more than a plain one);
// a plain planet yields one plain mineral of a family derived from
// its own seed, so the yield is stable and testable.
function yieldMineralsForPlanet(planet) {
  const yields = [];
  const muts = planet.mutations || [];
  if (muts.length > 0) {
    for (const id of muts) {
      const def = Planet.mutationDef(id);
      yields.push({ family: (def && def.tags && def.tags[0]) || 'weird', mutation: id, source: 'salvage' });
    }
    const fams = CONFIG.MINERAL_FAMILIES;
    const pick = fams[Math.trunc(Planet.mulberry32(((planet.seed || 0) ^ 0xB0A7) >>> 0)() * fams.length)];
    yields.push({ family: pick, mutation: null, source: 'salvage' });
    return yields;
  }
  const fams = CONFIG.MINERAL_FAMILIES;
  const pick = fams[Math.trunc(Planet.mulberry32(planet.seed || 0)() * fams.length)];
  return [{ family: pick, mutation: null, source: 'salvage' }];
}

function addMinerals(state, specs) {
  const made = specs.map((s) => makeMineral(state, s));
  state.minerals.push(...made);
  return made;
}

// Recycle the CURRENT planet (Devon's loop): destroy it for minerals
// and immediately hatch a fresh one. The destroyed planet is NOT
// archived — it's gone, its minerals are what you keep. The new
// planet's birth roll is a plain roll (no tilt — feeding is gone).
// Generation +1 — a recycled planet is a new life.
function recycleCurrent(state, nextSeed) {
  if (!state.current) return { ok: false, reason: 'no current planet' };
  const destroyed = state.current;
  const minerals = addMinerals(state, yieldMineralsForPlanet(destroyed));
  state.generation += 1;
  state.current = makePlanet(nextSeed ? nextSeed() : randomSeed(), null, undefined, takenNamesFor(state), state.generation);
  recordDiscovery(state, state.current);
  // The destroyed planet may have been on a ring — clear that slot.
  normalizeSystem(state);
  return { ok: true, minerals, destroyedSeed: destroyed.seed, planet: state.current };
}

// Destroy the CURRENT planet (round 9 — Devon): destroy it for
// minerals and grow NOTHING — the player picks what grows next.
// The destroyed planet is NOT archived. Generation does NOT move
// (no new life).
function destroyCurrent(state) {
  if (!state.current) return { ok: false, reason: 'no current planet' };
  const destroyed = state.current;
  const minerals = addMinerals(state, yieldMineralsForPlanet(destroyed));
  state.current = null;
  // The destroyed planet may have been on a ring — clear that slot.
  normalizeSystem(state);
  return { ok: true, minerals, destroyedSeed: destroyed.seed };
}

// Salvage an ARCHIVED planet: destroy it for minerals, no new planet.
// index is the position in state.past.
function salvageArchived(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.past.length) {
    return { ok: false, reason: 'no such archived planet' };
  }
  const [destroyed] = state.past.splice(index, 1);
  const minerals = addMinerals(state, yieldMineralsForPlanet(destroyed));
  // A slot that pointed at the salvaged planet goes empty — the
  // planet is gone, but nothing else in the system moves.
  normalizeSystem(state);
  return { ok: true, minerals, destroyedSeed: destroyed.seed };
}

// ---------------------------------------------------------------------------
// Prestige (step 2) — two Civilization-stage planets make an offspring.
// ---------------------------------------------------------------------------

// Prestige eligibility: a planet that reached Civilization (2200+
// chars) and hasn't already been a parent. Archived records carry
// chars + usedAsParent; old records without the flag count as unused.
function prestigeEligible(planet) {
  if (!planet) return false;
  if ((planet.chars || 0) < CONFIG.PRESTIGE_MIN_CHARS) return false;
  if (planet.usedAsParent) return false;
  return true;
}

// Parent descriptors for the UI: { kind: 'current' } or
// { kind: 'past', index }. Each entry carries what the pick list shows.
function eligiblePrestigeParents(state) {
  const list = [];
  if (state.current && prestigeEligible(state.current)) {
    list.push({
      kind: 'current', index: -1,
      label: `Current — ${state.current.summary}`,
      seed: state.current.seed, generation: currentGeneration(state),
      chars: state.current.chars, mutations: (state.current.mutations || []).slice(),
    });
  }
  state.past.forEach((p, i) => {
    if (prestigeEligible(p)) {
      list.push({
        kind: 'past', index: i,
        label: `${p.summary} · Gen ${p.generation}`,
        seed: p.seed, generation: p.generation,
        chars: p.chars, mutations: (p.mutations || []).slice(),
      });
    }
  });
  return list;
}

function resolveParent(state, desc) {
  if (!desc) return null;
  if (desc.kind === 'current') return state.current;
  if (desc.kind === 'past' && Number.isInteger(desc.index)) return state.past[desc.index] || null;
  return null;
}

function parentKey(desc) {
  return desc.kind === 'current' ? 'current' : `past:${desc.index}`;
}

// The offspring's inheritance boosts: each parent mutation passes at
// a multiplied chance — ~2x if one parent has it, ~3x if both.
// Mutations neither parent has still roll at the base chance.
function inheritanceBoosts(parentMutationsA, parentMutationsB) {
  const boosts = {};
  const count = {};
  for (const id of [...parentMutationsA, ...parentMutationsB]) count[id] = (count[id] || 0) + 1;
  // The tilt is built from the inheritance CHANCES: generatePlanet
  // rolls each mutation at base chance x boost, so the boost is the
  // chance divided by the base (0.5 / 0.007 ≈ 71x). The panel shows
  // the chance itself, never the boost — nobody wants to read "71x".
  for (const [id, n] of Object.entries(count)) {
    const chance = n >= 2 ? CONFIG.PRESTIGE_INHERIT_CHANCE_BOTH : CONFIG.PRESTIGE_INHERIT_CHANCE_ONE;
    boosts[id] = chance / Planet.CONFIG.MUTATION_CHANCE;
  }
  return boosts;
}

// The lineage record the offspring always stores (names/seeds/stats),
// so the family tree stays visible even if parent-fate flips to
// destroy/merge.
function lineageRecord(planet, generation) {
  return {
    seed: planet.seed,
    name: nameForPlanet(planet),
    generation: generation === undefined ? null : generation,
    terrain: planet.terrain,
    summary: planet.summary,
    chars: planet.chars || 0,
    mutations: (planet.mutations || []).slice(),
  };
}

// Combine two Civilization-stage planets into an offspring: a new
// seed starting as dust (0 XP), whose birth roll is tilted by the
// parents' mutations (inheritance) and nothing else — there is no fed
// mineral anymore (round 10). The offspring becomes the new current
// planet; the old current planet is archived (retired if it was a
// parent, plain if not) — unless the parents were destroyed instead
// (flag). Parents STAY in the collection by default, but each can
// only be a parent ONCE.
function prestige(state, parentA, parentB, nextSeed) {
  const a = resolveParent(state, parentA);
  const b = resolveParent(state, parentB);
  if (!a || !b) return { ok: false, reason: 'parent not found' };
  if (parentKey(parentA) === parentKey(parentB)) return { ok: false, reason: 'pick two different planets' };
  if (!prestigeEligible(a) || !prestigeEligible(b)) {
    return { ok: false, reason: 'both parents must have reached Civilization and not already been parents' };
  }
  const mutsA = (a.mutations || []).slice();
  const mutsB = (b.mutations || []).slice();
  const genA = parentA.kind === 'current' ? currentGeneration(state) : a.generation;
  const genB = parentB.kind === 'current' ? currentGeneration(state) : b.generation;
  const parents = [lineageRecord(a, genA), lineageRecord(b, genB)];
  const currentIsParent = parentA.kind === 'current' || parentB.kind === 'current';
  // Round 11: the archive check comes FIRST — a refused fusion must
  // not mutate anything. The old current planet is archived below
  // (unless destroyed as a parent); when the archive is full the
  // fusion refuses before any parent is marked or journaled.
  const willArchive = state.current && !(CONFIG.PRESTIGE_CONSUMES_PARENTS && currentIsParent);
  if (willArchive && (state.past || []).length >= CONFIG.PAST_LIMIT) {
    return { ok: false, reason: 'archive full' };
  }
  if (CONFIG.PRESTIGE_CONSUMES_PARENTS) {
    // Destroy the parents: remove their collection records (a current
    // parent is destroyed below instead of archived). The offspring's
    // lineage record is all that remains of them.
    for (const [desc, planet, gen] of [[parentA, a, genA], [parentB, b, genB]]) {
      if (desc.kind === 'past') {
        const idx = state.past.findIndex((p) => p.seed === planet.seed && p.generation === gen);
        if (idx >= 0) state.past.splice(idx, 1);
      }
    }
  } else {
    a.usedAsParent = true;
    b.usedAsParent = true;
  }
  // The parents' journals record the fusion — added BEFORE the
  // archive below, so a current parent's entry travels in its
  // snapshot. A past parent's entry goes on its SNAPSHOT (that is
  // what survives a later revive); snapshot-less records take it
  // flat. (The full-check above already passed, so the archive
  // cannot refuse after this point.)
  const journalTarget = (desc, planet) => (desc.kind === 'current' ? planet : (planet.planet || planet));
  addJournal(journalTarget(parentA, a), 'prestige', 'Became a parent');
  addJournal(journalTarget(parentB, b), 'prestige', 'Became a parent');
  // The old current planet leaves the stage — archived (retired if it
  // was a parent) — unless it was just destroyed as a parent.
  if (willArchive) {
    const archived = archiveCurrent(state);
    if (!archived.ok) return { ok: false, reason: archived.reason };
  }
  const tilt = prestigeTilt(inheritanceBoosts(mutsA, mutsB));
  state.generation += 1;
  const offspring = makePlanet(nextSeed ? nextSeed() : randomSeed(), null, tilt, takenNamesFor(state), state.generation);
  offspring.parents = parents;
  addJournal(offspring, 'prestige', `Born of ${nameForPlanet(a)} + ${nameForPlanet(b)}`);
  state.current = offspring;
  recordDiscovery(state, offspring);
  return { ok: true, planet: offspring, parents };
}

// Move the current planet into the collection record. The record
// keeps a FULL snapshot of the planet (`planet`) — every trait the
// renderer needs (rings, moons, size, mutation-granted traits like
// ringHue) — because re-rolling from the seed alone cannot reproduce
// a tilted birth roll. Flat fields stay for backwards compatibility
// and for the tests that read them. The snapshot carries the
// planet's journal, so the story travels with it.
// Returns { ok } — round 11: when the archive is full (PAST_LIMIT)
// archiving REFUSES instead of silently deleting the oldest planet.
// Callers surface 'archive full' and the player frees a slot by
// salvaging an archived planet.
function archiveCurrent(state) {
  if (!state.current) return { ok: true };
  if ((state.past || []).length >= CONFIG.PAST_LIMIT) {
    return { ok: false, reason: 'archive full' };
  }
  const c = state.current;
  state.past.push({
    seed: c.seed,
    name: nameForPlanet(c),
    terrain: c.terrain,
    terrainLabel: c.terrainLabel,
    summary: c.summary,
    chars: c.chars,
    // The planet's OWN generation (round 7) — a planet born as Gen 2
    // archives as Gen 2, even if an older planet is reactivated
    // later and the lives counter has moved on. Old planets without
    // the stamp fall back to the counter, which is right for them.
    generation: Number.isInteger(c.generation) ? c.generation : state.generation,
    archivedAt: Date.now(),
    mutations: (c.mutations || []).slice(),
    parents: c.parents ? c.parents.map((p) => ({ ...p, mutations: (p.mutations || []).slice() })) : null,
    usedAsParent: !!c.usedAsParent,
    planet: JSON.parse(JSON.stringify(c)),
  });
  normalizeSystem(state);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Solar system (step 4) — the collection view's slots and ranks.
// The collection (state.past) is unlimited; the solar system
// (state.system) only DISPLAYS one planet per orbit ring. A slot is
// null (empty) or { seed, generation } — looked up by seed+generation
// so it survives the planet moving between current and archived.
// ---------------------------------------------------------------------------

// Finished planets = archived planets. The current (growing) planet
// does not count — a rank is earned by FINISHING planets. A finished
// planet carrying Double Rings counts DOUBLE (round 10 perk: its
// double ring is two rings' worth of system).
function finishedCount(state) {
  let n = 0;
  for (const p of (state.past || [])) {
    n += 1;
    if ((p.mutations || []).includes('double-rings')) n += 1;
  }
  return n;
}

// System Rank: floor(finished / 3). Each rank unlocks +1 ring, from
// 4 rings at Rank 0 up to SYSTEM_MAX_RINGS. nextAt is the finished
// count the NEXT rank needs (null at max rank); toNext is how many
// more finished planets that takes.
function systemRank(state) {
  const finished = finishedCount(state);
  const maxRank = CONFIG.SYSTEM_MAX_RINGS - CONFIG.SYSTEM_BASE_RINGS;
  const rank = Math.min(Math.floor(finished / CONFIG.SYSTEM_FINISHED_PER_RANK), maxRank);
  const totalSlots = CONFIG.SYSTEM_BASE_RINGS + rank;
  const nextAt = rank >= maxRank ? null : (rank + 1) * CONFIG.SYSTEM_FINISHED_PER_RANK;
  return {
    rank,
    finished,
    totalSlots,
    maxRank,
    nextAt,
    toNext: nextAt === null ? 0 : nextAt - finished,
  };
}

// The unlock label for a locked ring, e.g. "Ring 5 — grow 3 more
// planets". The locked ring IS the progression UI: it always says
// what it takes to open it. Null when the ring is already unlocked.
function lockedRingLabel(state, ringIndex) {
  const rank = systemRank(state);
  if (ringIndex < rank.totalSlots) return null;
  if (rank.nextAt === null) return `Ring ${ringIndex + 1} — max rings reached`;
  // The next rank opens ring (totalSlots + 1); further rings open one
  // rank at a time after that, 3 finished planets per rank.
  const ranksAway = ringIndex - rank.totalSlots + 1;
  const needed = rank.nextAt + (ranksAway - 1) * CONFIG.SYSTEM_FINISHED_PER_RANK;
  const more = needed - rank.finished;
  return `Ring ${ringIndex + 1} — grow ${more} more planet${more === 1 ? '' : 's'}`;
}

// Find the planet a slot points at: an archived record first, then
// the current planet (same seed+generation — a slot survives its
// planet moving into the archive). Returns { kind, record } or
// null when the planet is gone (salvaged) — a stale slot.
function resolveSlotPlanet(state, slot) {
  if (!slot) return null;
  const rec = (state.past || []).find((p) => p.seed === slot.seed && p.generation === slot.generation);
  if (rec) return { kind: 'past', record: rec };
  if (state.current && state.current.seed === slot.seed && currentGeneration(state) === slot.generation) {
    return { kind: 'current', record: state.current };
  }
  return null;
}

// Which ring a planet is on, or -1 when it is not displayed.
function slotIndexForPlanet(state, seed, generation) {
  return (state.system || []).findIndex((s) => s && s.seed === seed && s.generation === generation);
}

// Keep the slot array honest. Called after anything that changes the
// collection or the rank: pads to the unlocked ring count, clears
// slots past it (a rank can DROP when a planet is salvaged — the
// planet returns to the archive, it is never deleted), and clears
// slots whose planet no longer exists.
function normalizeSystem(state) {
  if (!Array.isArray(state.system)) state.system = [null, null, null, null];
  const totalSlots = systemRank(state).totalSlots;
  while (state.system.length < totalSlots) state.system.push(null);
  for (let i = 0; i < state.system.length; i++) {
    if (i >= totalSlots) { state.system[i] = null; continue; }
    const slot = state.system[i];
    if (slot && !resolveSlotPlanet(state, slot)) state.system[i] = null;
  }
}

// Put a planet on a ring. The planet must exist (archived or current)
// and not already be displayed on another ring; the ring must be
// unlocked. Removing is separate — a placed planet stays put until
// the player removes it.
function placePlanet(state, slotIndex, seed, generation) {
  normalizeSystem(state);
  const rank = systemRank(state);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= rank.totalSlots) {
    return { ok: false, reason: 'no such ring' };
  }
  const exists = (state.past || []).some((p) => p.seed === seed && p.generation === generation)
    || (state.current && state.current.seed === seed && currentGeneration(state) === generation);
  if (!exists) return { ok: false, reason: 'no such planet' };
  const already = slotIndexForPlanet(state, seed, generation);
  if (already >= 0) return { ok: false, reason: 'already in your system' };
  state.system[slotIndex] = { seed, generation };
  return { ok: true };
}

// Take a planet off its ring. The planet is NOT deleted — it stays
// in the collection (the Archive) and can be placed again later.
function removeFromSystem(state, slotIndex) {
  normalizeSystem(state);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= (state.system || []).length) {
    return { ok: false, reason: 'no such ring' };
  }
  if (!state.system[slotIndex]) return { ok: false, reason: 'ring is empty' };
  const removed = state.system[slotIndex];
  state.system[slotIndex] = null;
  return { ok: true, removed };
}

// Add n XP (typed characters) to the current planet. Handles stage
// changes only — there is NO automatic rebirth (cut Nov 12): a maxed
// planet keeps gaining XP indefinitely, and a new planet only starts
// when the player asks for one (newPlanet / recycle / prestige).
// nextSeed is kept for signature compatibility and is unused.
// Returns { stageChanged, rebirthed, becameMax, stageIdx } for the
// caller to decide what to refresh. rebirthed is always false now
// (kept so callers don't change); becameMax is true exactly once,
// on the transition into Civilization (2200+ XP).
function applyXp(state, n, nextSeed, rng) {
  if (!state.current || n <= 0) {
    return {
      stageChanged: false,
      rebirthed: false,
      becameMax: false,
      stageIdx: state.current ? stageForXp(state.current.xp) : 0,
      event: null,
    };
  }
  const before = stageForXp(state.current.xp);
  state.current.xp += n;
  state.current.chars += n;
  const after = stageForXp(state.current.xp);
  // Round 11 — the Discovery Journal: a stage-up is a journal entry,
  // and a stage-up is also when a rare story event can happen
  // (journal-only, no visual change).
  let event = null;
  if (before !== after) {
    addJournal(state.current, 'stage', `Reached ${Planet.STAGES[after].name}`);
    const ev = rollEvent(state.current, rng);
    if (ev) {
      addJournal(state.current, 'event', ev.text, ev.title);
      event = { title: ev.title, text: ev.text };
    }
  }
  return {
    stageChanged: before !== after,
    rebirthed: false,
    becameMax: before < DISPLAY_STAGE_MAX && after >= DISPLAY_STAGE_MAX,
    stageIdx: after,
    event,
  };
}

// "New planet" command: archive the living planet (if any) and hatch a
// fresh one. Generation +1 — a manual new planet is a new life, on
// demand. The birth roll is plain (no tilt — feeding is gone).
// starterTerrain (round 9 — Devon): the mineral pick is only for the
// first planet; later births are random by default, but the
// post-destroy prompt can still offer the pick — pass the picked
// terrain here and the birth is tilted toward it, like the first run.
function newPlanet(state, nextSeed, starterTerrain) {
  if (state.current) {
    const archived = archiveCurrent(state);
    if (!archived.ok) return { ok: false, reason: archived.reason };
  }
  state.generation += 1;
  state.current = makePlanet(nextSeed ? nextSeed() : randomSeed(), starterTerrain || null, undefined, takenNamesFor(state), state.generation);
  recordDiscovery(state, state.current);
  return { ok: true, planet: state.current };
}

// "Grow this planet again" (round 7 — Devon): make an ARCHIVED
// planet the living one, from the Index. The planet comes back
// exactly as it was archived — same XP, same stage, same mutations,
// same generation (its birth order never changes) — and typing grows
// it again. The planet that was growing is archived into the
// collection in its place, so nothing is lost: switching back is
// the same tap in reverse. The lives counter (state.generation)
// does NOT move — this is not a new life, it is an old one resumed.
// A ring the revived planet was on stays its ring: slots are keyed
// by seed+generation and the revived planet keeps both.
// index is the position in state.past. Refuses records without a
// full planet snapshot (pre-step-4) — re-rolling one from its seed
// could not reproduce a tilted birth roll faithfully.
function makeCurrent(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= (state.past || []).length) {
    return { ok: false, reason: 'no such archived planet' };
  }
  const record = state.past[index];
  if (!record.planet) {
    return { ok: false, reason: 'planet has no saved snapshot' };
  }
  const seed = record.seed;
  const gen = record.generation;
  if (state.current) {
    const archived = archiveCurrent(state);
    if (!archived.ok) return { ok: false, reason: archived.reason };
  }
  // Remove by identity, not by position: archiveCurrent appends to
  // the end of past — the target's index may have moved.
  const at = state.past.findIndex((p) => p.seed === seed && p.generation === gen);
  if (at < 0) {
    return { ok: false, reason: 'planet left the collection' };
  }
  const [revived] = state.past.splice(at, 1);
  const planet = JSON.parse(JSON.stringify(revived.planet));
  // Stamp the record's generation onto the revived planet: the
  // snapshot predates the generation stamp for old planets, and the
  // record's generation is the authoritative birth order.
  planet.generation = revived.generation;
  state.current = planet;
  addJournal(state.current, 'grow', 'Grew again');
  normalizeSystem(state);
  return { ok: true, planet: state.current };
}

// ---------------------------------------------------------------------------
// Seed hatch (Nov 12 — Devon): hatch a planet from a shared seed.
// A seed hatches the exact same planet — same seed = same planet —
// but the hatched planet NEVER carries mutations: the seed's base
// planet, mutations stripped (Planet.stripMutations). Mutations stay
// unique to the original — nobody gets your rare mutated planet just
// by pasting its seed.
//
// One honest limit, now closed (Nov 12 seed-hatch fix): a FIRST
// planet born from a starter pick has its terrain forced by the
// pick, not the seed — so its share prints the seed TAGGED with the
// terrain ("948502300-icy", via shareSeedFor): the tag is a note on
// the share, the seed number never changes, and hatching the tagged
// seed reproduces the pinned terrain. A bare seed hatches the seed's
// canonical terrain (the weighted roll). Every later planet (new
// planet / recycle / prestige) is born from the seed alone, so those
// reproduce exactly from the bare seed.
// ---------------------------------------------------------------------------

// Parse a pasted seed for "Hatch from seed": a plain integer in the
// range randomSeed() produces (0..999999999), optionally followed by
// "-terrain" — the tagged form a share card prints when the planet's
// terrain was pinned by a starter pick ("948502300-icy"). The terrain
// is a note on the share, not part of the seed: the seed number is
// never modified, and its rings/moons/size/name rolls are untouched
// (the starter pick consumes one rng draw either way). A bare seed
// keeps the old behavior — the weighted terrain roll. Rejects empty
// input, non-digits, negatives, decimals, out-of-range numbers, and
// unknown terrain names with a plain reason the input box can show.
// The terrain match is case-insensitive ("948502300-ICY" works);
// spaces around the hyphen are tolerated.
function parseSeedInput(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, reason: 'Enter a seed number.' };
  const parts = t.split('-');
  if (parts.length > 2) {
    return { ok: false, reason: 'A shared seed looks like 948502300 or 948502300-icy.' };
  }
  const numPart = parts[0].trim();
  if (!/^\d+$/.test(numPart)) return { ok: false, reason: 'A seed is a whole number — digits only.' };
  const seed = Number(numPart);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999999) {
    return { ok: false, reason: 'Seed must be between 0 and 999999999.' };
  }
  let terrain = null;
  if (parts.length === 2) {
    const raw = parts[1].trim();
    if (!raw) {
      return { ok: false, reason: 'A shared seed looks like 948502300 or 948502300-icy.' };
    }
    const known = Planet.CONFIG.TERRAINS.find((x) => x.id === raw.toLowerCase());
    if (!known) {
      return { ok: false, reason: `Unknown terrain '${raw}' — use one of: rocky, ocean, jungle, icy, desert, lava, gas, crystal, toxic, metal.` };
    }
    terrain = known.id;
  }
  return { ok: true, seed, terrain };
}

// The seed's base planet, mutations stripped: same terrain, rings,
// moons, size and name as the seed's canonical planet — the name is
// seed-derived (same seed = same name), nudged only when that name
// is already taken in this collection (the same birth-time
// uniqueness rule every other birth follows). `terrain` (optional)
// pins the terrain — a tagged share ("948502300-icy") hatches the
// pinned terrain instead of the seed's canonical roll; without it
// the bare-seed behavior stands.
function makeSeedPlanet(seed, takenNames, terrain, generation) {
  const p = Planet.stripMutations(Planet.generatePlanet(seed, terrain || undefined));
  if (takenNames) p.name = uniquePlanetName(p.name, seed, takenNames);
  p.xp = 0;
  p.chars = 0;
  p.usedAsParent = false;
  p.parents = null;
  if (Number.isInteger(generation)) p.generation = generation;
  seedBornJournal(p);
  return p;
}

// "Hatch from seed" command: archive the living planet (kept in the
// collection) and hatch the seed's base planet, mutations stripped.
// Generation +1 — a seed-hatched planet is a new life, on demand.
// NO tilt is applied: the seed's canonical form is the point — a
// tilt would change the planet away from it. When there is no current
// planet yet (first run), the seed hatch IS the first planet (starter
// done + the one free starter mineral), so the first-run pick never
// pops up afterwards.
function hatchFromSeed(state, seed, terrain) {
  if (state.current) {
    const archived = archiveCurrent(state);
    if (!archived.ok) return { ok: false, reason: archived.reason };
    state.generation += 1;
  } else if (!state.starterDone) {
    state.starterDone = true;
    grantStarterMineral(state);
  } else {
    state.generation += 1;
  }
  state.current = makeSeedPlanet(seed, takenNamesFor(state), terrain, state.generation);
  return { ok: true, planet: state.current };
}

// ---------------------------------------------------------------------------
// Share card (P0, Nov 12 — Devon picked it first from the popularity
// assessment). One click: the planet's art + name, seed, stage and
// mutation, as a PNG for X/Reddit and a Markdown block for a README.
// The PNG itself is rendered in the webview (canvas from the planet
// grid); these pure helpers build the filename and the README markdown
// so the panel and the tests agree on exactly what gets shared.
// A seed hatches the exact same planet — same seed = same planet —
// so the seed IS the shareable planet: the markdown embeds it so a
// friend can paste it into their own Protoplanet and grow the same
// world. The image line points at the downloaded PNG file, which
// sits next to the README wherever the player puts it.
// ---------------------------------------------------------------------------
const SHARE_REPO_URL = 'https://github.com/devoncline/protoplanet';

// The seed as it is SHARED (Nov 12 seed-hatch fix): the bare seed
// when the planet's terrain is what its seed rolls anyway, otherwise
// the seed tagged with the terrain ("948502300-icy"). Only a planet
// born from a starter pick can differ from its seed's canonical
// terrain — the pick forced it — so only those shares carry a tag.
// The tag is a note on the share, never a change to the seed: the
// number and every roll after the terrain draw are identical either
// way (the starter pick consumes one rng draw). A planet with no
// stored terrain, or an unknown one, shares its bare seed, as before.
function shareSeedFor(planet) {
  if (!planet || typeof planet.seed !== 'number') return String(planet && planet.seed != null ? planet.seed : '');
  const terrain = planet.terrain;
  if (!terrain || !Planet.CONFIG.TERRAINS.some((t) => t.id === terrain)) return String(planet.seed);
  if (Planet.generatePlanet(planet.seed).terrain === terrain) return String(planet.seed);
  return `${planet.seed}-${terrain}`;
}

// protoplanet-k2-277c-gen5.png — the catalog name slugified, so the
// file is readable and unique per planet (names are unique in a
// collection, and the generation disambiguates across collections).
function shareCardFilename(name, generation) {
  const slug = String(name || 'planet').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'planet';
  return `protoplanet-${slug}-gen${generation || 1}.png`;
}

// The README block. `planet` is the renderable shape from
// extension.js (name, seed, stageName, mutationLabel, generation,
// chars, terrainLabel). The mutation line only appears when the
// planet has one — a plain planet's card stays clean.
function shareCardMarkdown(planet, filename) {
  const lines = [];
  lines.push(`![${planet.name} — Protoplanet](${filename})`);
  lines.push('');
  lines.push(`**${planet.name}** · ${planet.terrainLabel || 'Protoplanet'} · ${planet.stageName} · Gen ${planet.generation} · grown from ${Number(planet.chars || 0).toLocaleString()} characters`);
  if (planet.mutationLabel) lines.push(planet.mutationLabel);
  lines.push(`Seed \`${shareSeedFor(planet)}\` — hatch the same base planet in [Protoplanet](${SHARE_REPO_URL}).`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Persistence (JSON in globalState under one key).
// ---------------------------------------------------------------------------

function serializeState(state) {
  return JSON.stringify(state);
}

// Parse stored JSON; anything invalid or from another version falls
// back to a fresh state rather than crashing the extension.
function deserializeState(json) {
  try {
    const s = JSON.parse(json);
    if (!s || typeof s !== 'object' || s.version !== 1) return freshState();
    if (s.current !== null && (typeof s.current !== 'object' || typeof s.current.seed !== 'number' || typeof s.current.xp !== 'number')) return freshState();
    if (!Array.isArray(s.past)) s.past = [];
    if (typeof s.generation !== 'number' || s.generation < 1) s.generation = 1;
    if (typeof s.starterDone !== 'boolean') s.starterDone = !!s.current;
    // Step 2 fields: old saves (from before minerals existed) get
    // defaults, plus a one-time starter mineral gift for players who
    // started before minerals existed.
    if (!Array.isArray(s.minerals)) s.minerals = [];
    if (typeof s.mineralSeq !== 'number' || s.mineralSeq < 0) s.mineralSeq = 0;
    if (typeof s.starterMineralGranted !== 'boolean') {
      s.starterMineralGranted = true;
      if (s.minerals.length === 0) s.minerals.push(makeMineral(s, CONFIG.STARTER_MINERAL));
    }
    // Round 10: the Mutation Index. Old saves get it rebuilt from
    // everything still observable — mutations on the current planet,
    // on archived planets, and on minerals in the inventory (a mineral
    // of a mutation means that mutation was seen). A legacy fed
    // mineral (feeding was cut in round 10) counts too, then the fed
    // slot is deleted — there is no fed slot anymore.
    if (!Array.isArray(s.discovered)) s.discovered = [];
    const seen = new Set(s.discovered);
    if (s.current) for (const id of (s.current.mutations || [])) seen.add(id);
    for (const p of s.past) for (const id of (p.mutations || [])) seen.add(id);
    for (const m of s.minerals) if (m.mutation) seen.add(m.mutation);
    if (s.fedMineral && s.fedMineral.mutation) seen.add(s.fedMineral.mutation);
    s.discovered = [...seen];
    delete s.fedMineral;
    // Step 4 fields: old saves get an empty 4-ring system.
    if (!Array.isArray(s.system)) s.system = [null, null, null, null];
    // Round 11: the Discovery Journal. Old saves get a seeded birth
    // entry on every planet (timestamp = archivedAt for past records,
    // now for the current one) — the story starts from the migration;
    // earlier history is lost, but the planet keeps its birth. The
    // entry lives on the snapshot when there is one (that is what
    // the panels render); snapshot-less records keep it flat.
    const seedJournalFor = (planet, when) => {
      if (!planet || Array.isArray(planet.journal)) return;
      planet.journal = [{ t: when, kind: 'born', text: bornJournalText(planet) }];
    };
    if (s.current) seedJournalFor(s.current, Date.now());
    for (const p of s.past) {
      if (p.planet) seedJournalFor(p.planet, p.archivedAt || Date.now());
      else seedJournalFor(p, p.archivedAt || Date.now());
    }
    normalizeSystem(s);
    return s;
  } catch (e) {
    return freshState();
  }
}

module.exports = {
  CONFIG, COUNTED_SCHEMES,
  shouldCountDocument, countInsertedChars,
  stageForXp, stageInfo, displayStageForXp, isMaxed, xpBar,
  stageUpMessage, hatchMessage, mutationMessage, birthNotifications,
  randomSeed, makePlanet, currentGeneration, nameForPlanet, uniquePlanetName, takenNamesFor, freshState, startFirstPlanet,
  archiveCurrent, applyXp, newPlanet, makeCurrent, parseSeedInput, makeSeedPlanet, hatchFromSeed, shareSeedFor,
  finishedCount, systemRank, lockedRingLabel, resolveSlotPlanet,
  slotIndexForPlanet, normalizeSystem, placePlanet, removeFromSystem,
  mineralName, mineralApplyText, makeMineral, grantStarterMineral,
  recordDiscovery, setDef, setsForPlanet, setMessage, attemptMutation,
  prestigeTilt, mineralSummary, yieldMineralsForPlanet, addMinerals,
  recycleCurrent, salvageArchived, destroyCurrent,
  prestigeEligible, eligiblePrestigeParents, inheritanceBoosts,
  lineageRecord, prestige,
  shareCardFilename, shareCardMarkdown, SHARE_REPO_URL,
  serializeState, deserializeState,
};
