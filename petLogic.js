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
  // A mineral has ONE job, carried by `kind` (round 16 overhaul,
  // Nov 15 — Devon): 'birth' pays for exactly one birth and can do
  // nothing else; 'mutation' carries exactly one named mutation and
  // can never pay for a birth. There are no family minerals anymore
  // (families survive only as mutation tags / sets / earn combos /
  // the Family Pick selection). A mutated planet yields a mineral OF
  // its mutation when destroyed. Spend it to try to put that
  // mutation on the planet you love — right now, same planet,
  // same moment (round 10, Nov 12 — Devon's call: feeding a mineral
  // to tilt the NEXT planet's birth was confusing and clunky, cause
  // on one planet, effect on another, later. Feeding is gone.)
  MINERAL_FAMILIES: ['moon', 'rings', 'glow', 'storm', 'sky', 'weird'],

  // Families the shop's Family Mutation Mineral may draw from
  // (round 16 overhaul): Moon/Rings/Glow/Sky only. Storm/Weird are
  // NOT offered — a Storm pick would be a guaranteed Giant Storm
  // and a Weird pick a guaranteed Glitch.
  FAMILY_PICK_FAMILIES: ['moon', 'rings', 'glow', 'sky'],

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
  // 1.4%/2.1%, barely better than random, which made prestiging for a
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

  // --- Stardust economy (round 14, Nov 14 — Devon) ---------------------
  // The anti-farming update: births are no longer free spins for a
  // mutation. Stardust is earned PER CHARACTER TYPED (never over
  // time — no AFK farming, no Tamagotchi): every typed character
  // pays the sum of every planet in the system's earn rates.
  // A planet's rate = stage base x 1.5 per mutation x journal-event
  // multiplier x family combos. NO size factor (Devon: sizes can't
  // be adjusted easily). All numbers are first-draft — tunable here.
  // Stage bases by stage index (Shattered..Civilization).
  STAGE_EARN_BASE: [1, 1.5, 2, 3, 5, 8, 12],
  // Each mutation on a planet multiplies its rate by this.
  MUTATION_EARN_MULT: 1.5,
  // Family combos (Devon: families should pay the big money, so
  // farming every mutation onto ONE planet is not the best play):
  // 2 mutations from the same family on one planet = x1.5, 3+ = x2,
  // multiplied across families (Moon Lord + Ring King = x2 x x2).
  FAMILY_COMBO_2: 1.5,
  FAMILY_COMBO_3: 2,
  // Journal events add to a planet's rate (Devon: the journal is the
  // planet's history, so it should be worth something — no two
  // planets earn the same). Keyed by event title; the multiplier is
  // 1 + the sum of the planet's event bonuses.
  EVENT_EARN_BONUS: {
    'Crystal Bloom': 0.5,
    'Ancient Ruins': 0.4,
    'Strange Signal': 0.3,
    'Aurora': 0.3,
    'Comet Passing': 0.25,
    'Solar Storm': 0.2,
    'Meteor Impact': 0.15,
    'Deep Tremor': 0.1,
  },
  // Birth cost: every birth after the first costs 1 Birth mineral
  // from the inventory. The first planet ever is free. A mutated
  // planet only yields its mutation minerals when salvaged at stage
  // 3+ (Crust, 600 XP) — younger, only a Birth mineral, and the
  // mutation minerals are lost.
  BIRTH_MIN_STAGE_FOR_MUTATION_MINERALS: 3,
  // Shop prices (Stardust, flat — Devon, Nov 14: no diminishing
  // returns, too confusing; keep it simple, just higher prices).
  // Round 20 (Devon, Nov 15): prices raised — the power items went
  // x5, Birth only x2, because Stardust got too easy to farm.
  // The gamble gives a MINERAL, never a direct mutation — the
  // player still applies it with the 50% coin flip. The Birth
  // mineral stays cheap at 2,500 (cheap fuel): a new player must be
  // able to afford their first planet — never gate core gameplay
  // behind currency. The power items are expensive instead: a Moon
  // Lord at 81/char needs ~3,086 chars for a Random Mutation
  // Mineral, a plain Civ at 12/char needs ~20,833. The Mystery
  // Mineral is gone (round 15): at 5% it was a lottery ticket for
  // a Birth mineral you could just buy for half the price — Devon
  // removed it.
  // Round 22 (Devon, Nov 15): Birth 1,000 -> 2,500.
  SHOP_BIRTH_PRICE: 2500,
  SHOP_RANDOM_MUTATION_PRICE: 250000,
  SHOP_FAMILY_PICK_PRICE: 400000,
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
// Stardust economy (round 14) — what each planet earns per character.
// A planet is a "planet-like" object: a live planet (xp, mutations,
// journal) or an archived record (chars, mutations, planet snapshot
// carrying the journal). The normalizers below read both shapes, so
// earnRate works on either.
// ---------------------------------------------------------------------------

// XP of a planet-like: live planets carry xp, archived records carry
// chars (same number — 1 char = 1 XP).
function planetXp(p) {
  if (!p) return 0;
  if (typeof p.xp === 'number') return p.xp;
  return p.chars || 0;
}

// Journal of a planet-like: live planets carry it directly; archived
// records carry it in their snapshot (record.planet.journal).
function planetJournal(p) {
  if (!p) return [];
  if (Array.isArray(p.journal)) return p.journal;
  if (p.planet && Array.isArray(p.planet.journal)) return p.planet.journal;
  return [];
}

// Short display form of a rate: 12 -> "12", 1.5 -> "1.5", 5.0625 ->
// "5.1", 145.8 -> "145.8". One decimal max, trailing ".0" dropped.
function formatRate(r) {
  const v = Math.round(r * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// The journal-event multiplier: 1 + the sum of the planet's EVENT
// entries' bonuses (kind 'event' only — born/stage/mutation/
// prestige/grow entries never pay). Matched on the event title; an
// event never repeats on the same planet, so nothing double-counts.
function eventMultiplier(planet) {
  let bonus = 0;
  for (const e of planetJournal(planet)) {
    if (e.kind === 'event' && e.title) bonus += CONFIG.EVENT_EARN_BONUS[e.title] || 0;
  }
  return 1 + bonus;
}

// The family-combo details: one entry per family with 2+
// mutations on the planet (2 = x1.5, 3+ = x2). The multiplier
// below is the product of these — the breakdown UI lists them.
function familyComboDetails(planet) {
  const byFamily = {};
  for (const id of (planet.mutations || [])) {
    const def = Planet.mutationDef(id);
    const fam = (def && def.tags && def.tags[0]) || 'weird';
    byFamily[fam] = (byFamily[fam] || 0) + 1;
  }
  const out = [];
  for (const [fam, n] of Object.entries(byFamily)) {
    if (n >= 3) out.push({ family: fam, count: n, mult: CONFIG.FAMILY_COMBO_3 });
    else if (n === 2) out.push({ family: fam, count: n, mult: CONFIG.FAMILY_COMBO_2 });
  }
  return out;
}

// The family-combo multiplier: group the planet's mutations by
// family (a mutation's first tag). 2 from one family = x1.5, 3+ =
// x2, multiplied across families — so a Moon Lord + Ring King on
// one planet pays x2 x x2 = x4. One mutation in a family pays
// nothing extra (the 1.5x-per-mutation already covers it).
function familyComboMultiplier(planet) {
  let mult = 1;
  for (const d of familyComboDetails(planet)) mult *= d.mult;
  return mult;
}

// Stardust per character this planet earns:
//   stage base x 1.5 per mutation x journal-event multiplier x
//   family combos. NO size factor (Devon, Nov 14).
// Worked examples: plain Accretion = 1.5; plain Civ = 12; Civ with
// 3 moon mutations = 12 x 1.5^3 x 2 = 81; the same with Crystal
// Bloom + Aurora = 81 x 1.8 = 145.8.
function earnRate(planet) {
  if (!planet) return 0;
  const stage = stageForXp(planetXp(planet));
  const base = CONFIG.STAGE_EARN_BASE[stage] || 1;
  const n = (planet.mutations || []).length;
  return base * Math.pow(CONFIG.MUTATION_EARN_MULT, n) * eventMultiplier(planet) * familyComboMultiplier(planet);
}

// The planets in the system — the ones that earn Stardust. The
// current (growing) planet is always in, and so is every planet
// placed on an orrery ring (state.system slots). Archived planets
// sitting only in the Index/storage do NOT earn — that is the swap:
// keep the best earners on rings, bench the rest. A planet that is
// both current AND on a ring earns once (deduped by seed:generation).
function systemPlanets(state) {
  const out = [];
  const seen = new Set();
  const add = (planet) => {
    if (!planet) return;
    const key = `${planet.seed}:${Number.isInteger(planet.generation) ? planet.generation : state.generation}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(planet);
  };
  add(state.current);
  for (const slot of (state.system || [])) {
    const resolved = resolveSlotPlanet(state, slot);
    if (resolved) add(resolved.record);
  }
  return out;
}

// Total Stardust per character the whole system earns.
function systemEarnRate(state) {
  let total = 0;
  for (const p of systemPlanets(state)) total += earnRate(p);
  return total;
}

// --- Earnings breakdown (round 15) ---------------------------------------
// WHY a planet earns what it earns, line by line, so the economy
// stays understandable. Only lines that apply are shown (a plain
// planet is just its stage base). The lines multiply to the rate:
// e.g. a Civ Moon Lord is 12 x 3.375 x 2 = 81. Multipliers print
// exact (up to 3 decimals — 3.375, not 3.4): formatRate rounds to
// one decimal, which would make the lines not multiply to the
// total and confuse the player doing the math.
function formatMult(m) {
  const v = Math.round(m * 1000) / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

// The breakdown for one planet: its rate plus one line per factor
// (stage base, mutations, journal events, family combos).
function earnBreakdown(planet) {
  if (!planet) return null;
  const stage = stageForXp(planetXp(planet));
  const stageName = (Planet.STAGES[stage] || Planet.STAGES[0]).name;
  const base = CONFIG.STAGE_EARN_BASE[stage] || 1;
  const n = (planet.mutations || []).length;
  const mutationMult = Math.pow(CONFIG.MUTATION_EARN_MULT, n);
  const eventMult = eventMultiplier(planet);
  const eventTitles = planetJournal(planet)
    .filter((e) => e.kind === 'event' && e.title && (CONFIG.EVENT_EARN_BONUS[e.title] || 0) > 0)
    .map((e) => e.title);
  const combos = familyComboDetails(planet);
  const familyMult = combos.reduce((m, d) => m * d.mult, 1);
  const rate = base * mutationMult * eventMult * familyMult;
  const lines = [{ label: `${stageName} base`, value: formatRate(base) }];
  if (n > 0) lines.push({ label: `${n} mutation${n === 1 ? '' : 's'}`, value: `×${formatMult(mutationMult)}` });
  if (eventMult > 1) lines.push({ label: `Journal events (${eventTitles.join(', ')})`, value: `×${formatMult(eventMult)}` });
  for (const d of combos) {
    lines.push({
      label: `${d.family.charAt(0).toUpperCase() + d.family.slice(1)} family combo`,
      value: `×${formatMult(d.mult)}`,
    });
  }
  return {
    name: nameForPlanet(planet),
    rate, rateText: formatRate(rate),
    stageName, base, mutationCount: n, mutationMult,
    eventMult, eventTitles, familyCombos: combos, familyMult,
    lines,
  };
}

// The whole system's breakdown: the total plus one breakdown per
// earning planet, in system order (current planet first).
function systemEarnBreakdown(state) {
  const planets = systemPlanets(state).map((p) => earnBreakdown(p)).filter(Boolean);
  const total = planets.reduce((t, b) => t + b.rate, 0);
  return { total, totalText: formatRate(total), planets };
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
    version: 2,
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
    // Round 10: the Mutation Index — every mutation id ever seen on
    // a planet you grew (birth roll, successful apply, prestige
    // offspring). A mutation is "found" forever, even after the
    // planet that carried it is destroyed.
    discovered: [], // [mutationId, ...]
    // Round 14: Stardust — the economy currency. Earned per
    // character typed (never over time), spent in the shop on plain
    // minerals and mutation gambles. Fractional internally; the UI
    // shows it rounded down.
    stardust: 0,
  };
}

// First run: hatch the first planet, optionally biased by the starter
// terrain the user picked (undefined = fully random). No starter
// mineral anymore (round 16 overhaul, Nov 15 — Devon): the first
// planet is free, and the player starts with zero minerals and zero
// Stardust. The birth is recorded in the Mutation Index.
function startFirstPlanet(state, seed, starterTerrain) {
  state.current = makePlanet(seed, starterTerrain, undefined, takenNamesFor(state), state.generation);
  recordDiscovery(state, state.current);
  state.starterDone = true;
  return state.current;
}

// ---------------------------------------------------------------------------
// Shared probability helpers (round 16 overhaul, Nov 15 — Devon).
// ONE source of truth: these functions drive the actual rolls AND
// the odds the UI displays, so a displayed number can never drift
// from the real roll. No probability constant is duplicated anywhere
// else — the rolls below call these helpers, they do not restate
// the numbers. All odds are derived from Planet.CONFIG
// (MUTATION_CHANCE, MUTATIONS) and petLogic CONFIG (MUTATE_CHANCE,
// PRESTIGE_INHERIT_CHANCE_*), never from literals.
// ---------------------------------------------------------------------------

// Birth odds: one independent roll per mutation at MUTATION_CHANCE.
// perMutation is the per-mutation chance; any is the chance of at
// least one mutation; twoPlus is the chance of two or more.
function birthMutationOdds() {
  const p = Planet.CONFIG.MUTATION_CHANCE;
  const n = Planet.CONFIG.MUTATIONS.length;
  const none = Math.pow(1 - p, n);
  const exactlyOne = n * p * Math.pow(1 - p, n - 1);
  return { perMutation: p, any: 1 - none, twoPlus: 1 - none - exactlyOne };
}

// The apply coin flip: success or fizzle, mineral consumed either way.
function applyOdds() {
  return { success: CONFIG.MUTATE_CHANCE, failure: 1 - CONFIG.MUTATE_CHANCE };
}

// The Random Mutation Mineral: a uniform draw over all mutations.
function wheelOdds() {
  return { perMutation: 1 / Planet.CONFIG.MUTATIONS.length };
}

// The Family Mutation Mineral: a uniform draw over the mutations in
// one family. Storm/Weird are NOT offered (a pick there would be a
// guaranteed Giant Storm / Glitch), and unknown families are
// rejected too — the caller gets { ok: false } and refuses the buy.
function familyPickOdds(family) {
  if (!CONFIG.MINERAL_FAMILIES.includes(family)) return { ok: false, reason: 'unknown family' };
  if (!CONFIG.FAMILY_PICK_FAMILIES.includes(family)) return { ok: false, reason: 'not offered' };
  const mutations = Planet.CONFIG.MUTATIONS
    .filter((m) => (m.tags || []).includes(family))
    .map((m) => m.id);
  return { ok: true, family, perMutation: 1 / mutations.length, mutations };
}

// Prestige inheritance: the chance one parent mutation passes to
// the offspring — 50% from one parent, 75% from both, and the base
// birth chance when neither parent carries it.
function inheritanceOdds(parentsCarrying) {
  if (parentsCarrying >= 2) return CONFIG.PRESTIGE_INHERIT_CHANCE_BOTH;
  if (parentsCarrying === 1) return CONFIG.PRESTIGE_INHERIT_CHANCE_ONE;
  return Planet.CONFIG.MUTATION_CHANCE;
}

// One formatter for every displayed odd, so "1 in 143" and "0.7%"
// can never disagree. Default is a percent ("50%", "7.69%",
// "0.7%"); style 'one-in' is the "1 in N" form ("1 in 13",
// "1 in 143", "1 in 2"). The intro's "about 1 in 10" is prose,
// not a formatter output — the exact computed any-mutation chance
// is 1 in 11 (8.73%).
function formatOdds(p, style) {
  if (typeof p !== 'number' || !(p > 0)) return style === 'one-in' ? 'never' : '0%';
  if (p >= 1) return style === 'one-in' ? '1 in 1' : '100%';
  if (style === 'one-in') return `1 in ${Math.round(1 / p)}`;
  const pct = (p * 100).toFixed(2).replace(/\.?0+$/, '');
  return `${pct}%`;
}

// ---------------------------------------------------------------------------
// Minerals (step 2) — the inventory and the mutate attempt (round 10).
// A mineral is { id, kind, family, mutation, source }:
//   * kind is the JOB (round 16 overhaul): 'birth' pays for exactly
//     one birth (family null, mutation null) and can do nothing else;
//     'mutation' carries exactly one mutation (family = its family)
//     and can never pay for a birth. No other kinds exist.
//   * source: 'shop' | 'salvage' (where it came from).
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
  return 'Birth mineral';
}

// Plain words for the UI: what does spending this mineral try to do?
function mineralApplyText(mineral) {
  if (!mineral) return '';
  if (mineral.mutation) {
    const def = Planet.mutationDef(mineral.mutation);
    const odds = applyOdds();
    return `${formatOdds(odds.success)} chance to put ${def ? def.name : mineral.mutation} on your planet — gone if it fizzles`;
  }
  return 'Pays for 1 birth — cannot be applied';
}

function makeMineral(state, spec) {
  state.mineralSeq += 1;
  const mutation = spec.mutation || null;
  let family = null;
  if (mutation) {
    const def = Planet.mutationDef(mutation);
    family = spec.family || (def && def.tags && def.tags[0]) || 'weird';
  }
  return {
    id: `min-${state.mineralSeq}`,
    kind: spec.kind || (mutation ? 'mutation' : 'birth'),
    family,
    mutation,
    source: spec.source || 'salvage',
  };
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
//   * A Birth mineral is REFUSED outright — it pays for births and
//     can never apply a mutation (round 16 overhaul; the UI filters
//     too, this is the logic-level enforcement).
//   * Blocked (mineral NOT consumed): the planet already has that
//     mutation.
// `rng` is the coin flip (defaults to Math.random; tests pass a fixed
// one). The flip uses applyOdds() — the same helper the UI displays
// — never a restated 0.5. The visuals use a SEEDED rng (seed +
// mutation), so the same apply always looks the same way. Returns
// { ok, success, mutationId, mutationName, setsCompleted } —
// setsCompleted lists the set ids the planet completed with this
// mutation, if any.
function attemptMutation(state, mineralId, rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  if (!state.current) return { ok: false, reason: 'no current planet' };
  const idx = (state.minerals || []).findIndex((m) => m.id === mineralId);
  if (idx < 0) return { ok: false, reason: 'no such mineral' };
  const mineral = state.minerals[idx];
  if (mineral.kind === 'birth' || !mineral.mutation) {
    return { ok: false, reason: 'birth mineral cannot be applied' };
  }
  const owned = new Set(state.current.mutations || []);
  if (owned.has(mineral.mutation)) return { ok: false, reason: 'planet already has it' };
  const targetId = mineral.mutation;
  // The mineral is spent — success or fizzle, it's gone.
  state.minerals.splice(idx, 1);
  const def = Planet.mutationDef(targetId);
  if (roll() >= applyOdds().success) {
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

// What the status bar / pet window shows about minerals: totals by
// KIND (round 16 overhaul) — Birth minerals pay for births,
// Mutation minerals each carry one mutation.
function mineralSummary(state) {
  let birth = 0, mutation = 0;
  for (const m of state.minerals || []) {
    if (m.kind === 'mutation' || (m.kind !== 'birth' && m.mutation)) mutation += 1;
    else birth += 1;
  }
  return {
    total: (state.minerals || []).length,
    birth,
    mutation,
  };
}

// ---------------------------------------------------------------------------
// Birth cost (round 14) — births are no longer free spins for a
// mutation. The anti-farming rule: the first planet ever is free,
// every later birth costs 1 Birth mineral from the inventory.
// ---------------------------------------------------------------------------

// The archive has room for one more planet. A pure capacity read
// (no mutation), so a birth can check it BEFORE paying the mineral
// and refuse cleanly instead of consuming one for a failed birth.
function archiveHasRoom(state) {
  return (state.past || []).length < CONFIG.PAST_LIMIT;
}

// Index of a Birth mineral (kind === 'birth') the birth cost can
// spend. A Mutation mineral can never pay for a birth (round 16
// overhaul — the kind IS the job). -1 when there is no Birth
// mineral at all.
function birthMineralIndex(state) {
  return (state.minerals || []).findIndex((m) => m.kind === 'birth');
}

// Pay for a birth: the first planet ever is free (starterDone is
// false — the player has never had a planet). Every later birth
// costs 1 Birth mineral from the inventory. Returns { ok, free,
// spent } or { ok: false, reason: 'no plain mineral' }.
// NOTE: the reason string is deliberately unchanged — extension.js
// keys its blocked-birth notice off 'no plain mineral' (7 call
// sites); the extension.js phase renames both sides together.
function payBirthCost(state) {
  if (!state.starterDone) return { ok: true, free: true, spent: null };
  const idx = birthMineralIndex(state);
  if (idx < 0) return { ok: false, reason: 'no plain mineral' };
  const [spent] = state.minerals.splice(idx, 1);
  return { ok: true, free: false, spent };
}

// Plain words for a blocked birth (the host shows it). The price
// comes from CONFIG, never a hardcoded number (round 22 — the old
// text said 1,000 after the price moved to 2,500).
function needPlainMineralMessage() {
  return 'Birthing a planet costs 1 Birth mineral — buy one in the shop (' + CONFIG.SHOP_BIRTH_PRICE.toLocaleString('en-US') + ' ✦) or salvage a planet.';
}

// ---------------------------------------------------------------------------
// Shop (round 14) — spend Stardust on minerals. Every purchase adds
// a MINERAL to the inventory, never a direct mutation: the player
// still applies it through the existing apply command (50% coin
// flip). A shop-bought mutation mineral does NOT mark the mutation
// "found" in the Mutation Index — discovery means seeing it on a
// planet (birth or a landed apply), not owning the bottle.
// Round 16 overhaul: the shop sells exactly three items — a Birth
// mineral (2,500 ✦, no family, no surprise), a Random Mutation
// Mineral (250,000 ✦, uniform 1 of 13), a Family Mutation Mineral
// (400,000 ✦, Moon/Rings/Glow/Sky only). There is no random-family
// draw anywhere anymore.
// ---------------------------------------------------------------------------

function randomMutationId(rng) {
  const all = Planet.CONFIG.MUTATIONS;
  return all[Math.trunc(rng() * all.length)].id;
}

function randomMutationMineralSpec(rng) {
  const id = randomMutationId(rng);
  const def = Planet.mutationDef(id);
  return { family: (def && def.tags && def.tags[0]) || 'weird', mutation: id, source: 'shop' };
}

// Buy a Birth mineral (2,500 ✦): exactly one birth, no family, no
// surprise — it can never apply a mutation. No rng needed: there is
// nothing random about it.
function buyBirthMineral(state) {
  if ((state.stardust || 0) < CONFIG.SHOP_BIRTH_PRICE) return { ok: false, reason: 'not enough stardust' };
  state.stardust -= CONFIG.SHOP_BIRTH_PRICE;
  const m = makeMineral(state, { kind: 'birth', family: null, mutation: null, source: 'shop' });
  state.minerals.push(m);
  return { ok: true, mineral: m };
}

// Random Mutation Mineral (250,000 ✦): guaranteed a random mutation
// mineral — which of the 13 is uniform (see wheelOdds()).
function buyRandomMutationMineral(state, rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  if ((state.stardust || 0) < CONFIG.SHOP_RANDOM_MUTATION_PRICE) return { ok: false, reason: 'not enough stardust' };
  state.stardust -= CONFIG.SHOP_RANDOM_MUTATION_PRICE;
  const m = makeMineral(state, randomMutationMineralSpec(roll));
  state.minerals.push(m);
  return { ok: true, mineral: m };
}

// Family Mutation Mineral (400,000 ✦): pick a family, get a random
// mutation mineral from inside it — the way to hunt a specific set
// (Moon Lord, Ring King) on purpose instead of hoping. Moon/Rings/
// Glow/Sky only; Storm/Weird are not offered (the draw would be a
// guaranteed Giant Storm / Glitch). The draw uses familyPickOdds(),
// the same helper the UI displays, so the odds can't drift.
function buyFamilyPick(state, family, rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  const odds = familyPickOdds(family);
  if (!odds.ok) return { ok: false, reason: odds.reason };
  if ((state.stardust || 0) < CONFIG.SHOP_FAMILY_PICK_PRICE) return { ok: false, reason: 'not enough stardust' };
  state.stardust -= CONFIG.SHOP_FAMILY_PICK_PRICE;
  const id = odds.mutations[Math.trunc(roll() * odds.mutations.length)];
  const m = makeMineral(state, { kind: 'mutation', family, mutation: id, source: 'shop' });
  state.minerals.push(m);
  return { ok: true, mineral: m };
}

// The mineral inventory for the inventory screen: minerals grouped
// by KIND (round 16 overhaul) — all Birth minerals together ("Pays
// for 1 birth"), then Mutation minerals by mutation — plus the
// Stardust balance. Mutation minerals first (alphabetical), then
// the Birth group.
function mineralInventory(state) {
  const byKey = new Map();
  for (const m of (state.minerals || [])) {
    const key = m.kind === 'birth' || !m.mutation ? 'birth|' : `mutation|${m.mutation}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        kind: m.kind === 'birth' || !m.mutation ? 'birth' : 'mutation',
        family: m.kind === 'birth' || !m.mutation ? null : m.family,
        mutation: m.kind === 'birth' || !m.mutation ? null : m.mutation,
        count: 0, sample: m,
      });
    }
    byKey.get(key).count += 1;
  }
  const groups = [...byKey.values()].map((g) => ({
    kind: g.kind,
    family: g.family,
    mutation: g.mutation,
    count: g.count,
    label: mineralName(g.sample),
    applyText: mineralApplyText(g.sample),
  }));
  groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'mutation' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return {
    stardust: state.stardust || 0,
    total: (state.minerals || []).length,
    groups,
  };
}

// ---------------------------------------------------------------------------
// Salvage / recycle (step 2) — destroying planets for minerals.
// ---------------------------------------------------------------------------

// What a destroyed planet yields. One mineral per mutation it carries
// (each carrying that mutation — the mineral remembers where it came
// from), PLUS one extra Birth mineral when it was mutated at all
// (round 10 perk: a mutated planet is worth more than a plain one);
// a plain planet yields one Birth mineral. Round 17 — Civilization
// bonus: a planet salvaged at stage 6 (Civilization, 2200 XP) yields
// a SECOND Birth mineral on top, so plain Civ yields 2 Birth and a
// mutated Civ yields its mutation minerals + 2 Birth. Counts are
// identical to before the overhaul — only the bonus mineral's kind
// changed: it is a Birth mineral now, never a random-family mineral.
function yieldMineralsForPlanet(planet) {
  const yields = [];
  const muts = planet.mutations || [];
  const birthSpec = () => ({ kind: 'birth', family: null, mutation: null, source: 'salvage' });
  // Round 14 — grow it first: a mutated planet only yields its
  // mutation minerals if it was grown to Crust (stage 3, 600 XP).
  // Salvaged younger, only a Birth mineral comes back — the
  // mutation minerals are lost (see salvageLostMutations). A plain
  // planet is unaffected below Civilization: one Birth mineral at
  // any stage; at Civilization it yields two (round 17).
  if (muts.length > 0 && stageForXp(planetXp(planet)) < CONFIG.BIRTH_MIN_STAGE_FOR_MUTATION_MINERALS) {
    return [birthSpec()];
  }
  for (const id of muts) {
    const def = Planet.mutationDef(id);
    yields.push({ kind: 'mutation', family: (def && def.tags && def.tags[0]) || 'weird', mutation: id, source: 'salvage' });
  }
  yields.push(birthSpec());
  // Round 17 — Civilization bonus: a second Birth mineral for a
  // planet salvaged at stage 6 (Civilization, 2200 XP).
  if (stageForXp(planetXp(planet)) >= 6) yields.push(birthSpec());
  return yields;
}

// What a salvage WOULD yield, before the player confirms: the exact
// mineral specs plus the exact mutations that would be lost to the
// grow-it-first rule. Pure — the UI states yield + losses before
// the confirm, nothing is destroyed by asking.
function salvagePreview(planet) {
  return {
    yields: yieldMineralsForPlanet(planet),
    lost: salvageLostMutations(planet),
  };
}

// The mutation ids a salvage LOSES to the grow-it-first rule: the
// planet's mutations when it is mutated but below Crust. Empty
// otherwise (grown, or plain) — nothing is lost.
function salvageLostMutations(planet) {
  const muts = planet.mutations || [];
  if (muts.length === 0) return [];
  if (stageForXp(planetXp(planet)) >= CONFIG.BIRTH_MIN_STAGE_FOR_MUTATION_MINERALS) return [];
  return muts.slice();
}

// The plain words for a loss: "GJ-364c was too young — its Blood
// Moon mineral was lost. Grow a mutated planet to Crust (600 XP)
// before salvaging to keep its mutation minerals." Null when
// nothing was lost.
function salvageLostMessage(planet, lost) {
  if (!lost || lost.length === 0) return null;
  const names = lost.map((id) => {
    const def = Planet.mutationDef(id);
    return def ? def.name : id;
  });
  const mineralWord = names.length === 1 ? 'mineral was' : 'minerals were';
  return `${nameForPlanet(planet)} was too young — its ${names.join(', ')} ${mineralWord} lost. Grow a mutated planet to Crust (600 XP) before salvaging to keep its mutation minerals.`;
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
  const lostMutations = salvageLostMutations(destroyed);
  const minerals = addMinerals(state, yieldMineralsForPlanet(destroyed));
  // Round 14 — the new birth costs 1 Birth mineral, paid out of the
  // yield + inventory. It always succeeds here: the yield has at
  // least 1 Birth mineral, so a recycle is self-funding — a plain
  // planet breaks even (net zero), a grown mutated planet keeps its
  // mutation minerals. Round 17 — a Civilization planet yields a
  // second Birth mineral, so recycling one nets +1 Birth on top:
  // plain Civ nets 1 Birth, mutated Civ nets its mutation minerals
  // + 1 Birth.
  const cost = payBirthCost(state);
  if (!cost.ok) return { ok: false, reason: cost.reason };
  state.generation += 1;
  state.current = makePlanet(nextSeed ? nextSeed() : randomSeed(), null, undefined, takenNamesFor(state), state.generation);
  recordDiscovery(state, state.current);
  // The destroyed planet may have been on a ring — clear that slot.
  normalizeSystem(state);
  return { ok: true, minerals, destroyedSeed: destroyed.seed, planet: state.current, spentMineral: cost.spent || null, lostMutations };
}

// Destroy the CURRENT planet (round 9 — Devon): destroy it for
// minerals and grow NOTHING — the player picks what grows next.
// The destroyed planet is NOT archived. Generation does NOT move
// (no new life).
function destroyCurrent(state) {
  if (!state.current) return { ok: false, reason: 'no current planet' };
  const destroyed = state.current;
  const lostMutations = salvageLostMutations(destroyed);
  const minerals = addMinerals(state, yieldMineralsForPlanet(destroyed));
  state.current = null;
  // The destroyed planet may have been on a ring — clear that slot.
  normalizeSystem(state);
  return { ok: true, minerals, destroyedSeed: destroyed.seed, lostMutations };
}

// Salvage an ARCHIVED planet: destroy it for minerals, no new planet.
// index is the position in state.past.
function salvageArchived(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.past.length) {
    return { ok: false, reason: 'no such archived planet' };
  }
  const [destroyed] = state.past.splice(index, 1);
  const lostMutations = salvageLostMutations(destroyed);
  const minerals = addMinerals(state, yieldMineralsForPlanet(destroyed));
  // A slot that pointed at the salvaged planet goes empty — the
  // planet is gone, but nothing else in the system moves.
  normalizeSystem(state);
  return { ok: true, minerals, destroyedSeed: destroyed.seed, lostMutations };
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
        label: `${p.summary}`,
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
// a multiplied chance — 50% if one parent has it, 75% if both.
// Mutations neither parent has still roll at the base chance.
// The boost is the inheritance CHANCE (see inheritanceOdds())
// divided by the base — generatePlanet rolls each mutation at base
// chance x boost. The boost itself stays internal, never displayed.
function inheritanceBoosts(parentMutationsA, parentMutationsB) {
  const boosts = {};
  const count = {};
  for (const id of [...parentMutationsA, ...parentMutationsB]) count[id] = (count[id] || 0) + 1;
  // The tilt is built from the inheritance CHANCES: generatePlanet
  // rolls each mutation at base chance x boost, so the boost is the
  // chance divided by the base (0.5 / 0.007 ≈ 71x). The panel shows
  // the chance itself, never the boost — nobody wants to read "71x".
  for (const [id, n] of Object.entries(count)) {
    boosts[id] = inheritanceOdds(n) / Planet.CONFIG.MUTATION_CHANCE;
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
  // Round 11: the archive check comes FIRST — a refused prestige must
  // not mutate anything. The old current planet is archived below
  // (unless destroyed as a parent); when the archive is full the
  // prestige refuses before any parent is marked or journaled.
  const willArchive = state.current && !(CONFIG.PRESTIGE_CONSUMES_PARENTS && currentIsParent);
  if (willArchive && (state.past || []).length >= CONFIG.PAST_LIMIT) {
    return { ok: false, reason: 'archive full' };
  }
  // Round 14 — the offspring is a birth: it costs 1 Birth mineral.
  // Checked here, after the archive check and before any parent is
  // marked or journaled, so a refused prestige mutates nothing.
  const cost = payBirthCost(state);
  if (!cost.ok) return { ok: false, reason: cost.reason };
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
  // The parents' journals record the prestige — added BEFORE the
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
  return { ok: true, planet: offspring, parents, spentMineral: cost.spent || null };
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
      stardustEarned: 0,
    };
  }
  const before = stageForXp(state.current.xp);
  state.current.xp += n;
  state.current.chars += n;
  const after = stageForXp(state.current.xp);
  // Round 11 — the Discovery Journal: a stage-up is a journal entry,
  // and a stage-up is also when a rare story event can happen
  // (journal-only, no visual change). This runs FIRST, before the
  // Stardust below — deliberate (round 15): a character that stages
  // the planet up AND triggers a discovery earns at the new stage's
  // rate INCLUDING the new event's bonus, not the pre-event rate.
  // The old order (rate first, event after) made the discovery
  // character pay out one character late — technically fine, but
  // the discovery should feel rewarding on the spot.
  let event = null;
  if (before !== after) {
    addJournal(state.current, 'stage', `Reached ${Planet.STAGES[after].name}`);
    const ev = rollEvent(state.current, rng);
    if (ev) {
      addJournal(state.current, 'event', ev.text, ev.title);
      event = { title: ev.title, text: ev.text };
    }
  }
  // Round 14 — Stardust: every typed character pays the system's
  // earn rate. The rate is read AFTER the XP lands and AFTER the
  // journal event above, so a character that stages the planet up
  // already earns at the new stage's rate, and a character that
  // triggers a discovery earns with the new event's bonus included.
  // (A multi-char change uses the post-change rate for all of it —
  // a few Stardust of generosity on a stage-up, not worth splitting.)
  if (typeof state.stardust !== 'number' || state.stardust < 0) state.stardust = 0;
  const rate = systemEarnRate(state);
  const stardustEarned = n * rate;
  state.stardust += stardustEarned;
  return {
    stageChanged: before !== after,
    rebirthed: false,
    becameMax: before < DISPLAY_STAGE_MAX && after >= DISPLAY_STAGE_MAX,
    stageIdx: after,
    event,
    stardustEarned,
  };
}

// "New planet" command: archive the living planet (if any) and hatch a
// fresh one. Generation +1 — a manual new planet is a new life, on
// demand. The birth roll is plain (no tilt — feeding is gone).
// starterTerrain (round 9 — Devon): the terrain pick is only for the
// first planet; later births are random by default, but the
// post-destroy prompt can still offer the pick — pass the picked
// terrain here and the birth is tilted toward it, like the first run.
function newPlanet(state, nextSeed, starterTerrain) {
  // Round 14 — check both refusals BEFORE mutating anything: the
  // archive must have room, and the birth must be paid for (the
  // first planet ever is free). A refused birth leaves the current
  // planet and the inventory untouched.
  if (state.current && !archiveHasRoom(state)) return { ok: false, reason: 'archive full' };
  const cost = payBirthCost(state);
  if (!cost.ok) return { ok: false, reason: cost.reason };
  // A first planet through this path (unreachable in the UI — the
  // first-run pick owns it) still gets the free-first-birth treatment:
  // starterDone is set, nothing is granted (round 16 overhaul — no
  // starter mineral anymore).
  if (!state.starterDone) {
    state.starterDone = true;
  }
  if (state.current) {
    const archived = archiveCurrent(state);
    if (!archived.ok) return { ok: false, reason: archived.reason };
  }
  state.generation += 1;
  state.current = makePlanet(nextSeed ? nextSeed() : randomSeed(), starterTerrain || null, undefined, takenNamesFor(state), state.generation);
  recordDiscovery(state, state.current);
  return { ok: true, planet: state.current, spentMineral: cost.spent || null };
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
  // Round 22 (Devon, Nov 15): no journal entry for growing again —
  // the revive is not a story beat, and the "X is growing again!"
  // toast already says it. (The old addJournal('grow', 'Grew again')
  // call lived here; existing entries are stripped on load.)
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
// done, still Gen 1, no mineral granted — round 16 overhaul), so the
// first-run pick never pops up afterwards.
function hatchFromSeed(state, seed, terrain) {
  // Round 14 — check both refusals BEFORE mutating anything: the
  // archive must have room (when a planet is being archived), and
  // the birth must be paid for (the first planet ever is free).
  if (state.current && !archiveHasRoom(state)) return { ok: false, reason: 'archive full' };
  const cost = payBirthCost(state);
  if (!cost.ok) return { ok: false, reason: cost.reason };
  if (state.current) {
    const archived = archiveCurrent(state);
    if (!archived.ok) return { ok: false, reason: archived.reason };
    state.generation += 1;
  } else if (!state.starterDone) {
    state.starterDone = true;
  } else {
    state.generation += 1;
  }
  state.current = makeSeedPlanet(seed, takenNamesFor(state), terrain, state.generation);
  return { ok: true, planet: state.current, spentMineral: cost.spent || null };
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
  lines.push(`**${planet.name}** · ${planet.terrainLabel || 'Protoplanet'} · ${planet.stageName} · grown from ${Number(planet.chars || 0).toLocaleString()} characters`);
  if (planet.mutationLabel) lines.push(planet.mutationLabel);
  lines.push(`Seed \`${shareSeedFor(planet)}\` — hatch the same base planet in [Protoplanet](${SHARE_REPO_URL}).`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Persistence (JSON in globalState under one key).
// ---------------------------------------------------------------------------

function serializeState(state) {
  // Stamps version 2 without mutating the live state object.
  return JSON.stringify({ ...state, version: 2 });
}

// Migrate a v1 save to v2 (round 16 overhaul). Pure: no I/O, same
// input -> same output, and idempotent — a v2 state is returned
// unchanged, so running it twice is running it once.
//   * Mutation mineral (mutation set, any source) -> unchanged
//     (kind normalized to 'mutation', family filled from the
//     mutation's tags when missing).
//   * Plain / family mineral (mutation null, any family, any
//     source) -> Birth mineral (kind 'birth', family null).
//     Count preserved 1:1; the hidden family is dropped.
//   * Starter Crystal (kind 'crystal', source 'starter', unspent)
//     -> one Birth mineral (same rule: mutation null -> Birth).
//   * The starterMineralGranted flag is deleted — it means nothing
//     anymore.
// Keyed off mutation presence + source, NOT old kind strings, so
// saves whose kind values predate the current code migrate too.
// Stardust, planets, XP, journals, lineage, system, archive and
// `discovered` are untouched.
function migrateV1toV2(state) {
  if (!state || typeof state !== 'object') return state;
  if (state.version === 2) return state;
  if (Array.isArray(state.minerals)) {
    for (const m of state.minerals) {
      if (m.mutation) {
        m.kind = 'mutation';
        if (!m.family) {
          const def = Planet.mutationDef(m.mutation);
          m.family = (def && def.tags && def.tags[0]) || 'weird';
        }
      } else {
        m.kind = 'birth';
        m.family = null;
        m.mutation = null;
      }
    }
  }
  delete state.starterMineralGranted;
  state.version = 2;
  return state;
}

// Parse stored JSON. Returns a RESULT, not a bare state, so the
// caller can tell the cases apart:
//   { state, backupJson, notice, migrated, corrupt }
//   * state — the loaded (or fresh) state. Always a state object.
//   * backupJson — the raw input JSON the caller must stash under
//     the backup key BEFORE any save overwrites it, or null when no
//     backup is needed.
//   * notice — a one-time message for the player, or null.
//   * migrated — true when a v1 save was migrated to v2.
//   * corrupt — true when the input was unreadable (bad JSON,
//     unknown version, malformed planet). The caller must NOT
//     treat the fresh state as a replacement save: writes stay
//     blocked until the player explicitly chooses recovery or a
//     new game (round 21).
// Cases:
//   * Empty input ('', null, undefined) — a brand-new install: fresh
//     state, no backup, no notice, not corrupt. ("Fresh because empty/new".)
//   * Valid v2 — the state, no backup, no notice, not corrupt.
//   * Valid v1 — migrated to v2; backupJson is the raw v1 JSON
//     (the caller writes it to `protoplanet.state.backup.v1`
//     before saving the migrated state); no notice, migration is
//     a normal upgrade, not corrupt.
//   * Corrupt JSON, unknown version, or a malformed current planet
//     — fresh state, backupJson is the raw input, notice tells the
//     player once ("Your save couldn't be read — backed up,
//     starting fresh."). NEVER silently replaces an incompatible
//     save with a fresh game: the raw JSON is handed back for
//     backup first, and the caller must write it before saving.
//     (Round 21: the caller also blocks writes and asks the player
//     what to do — the notice text is kept for the message, but
//     "starting fresh" no longer happens on its own.)
// Discovery rebuild (round 16 overhaul — hole K): only mutations
// seen ON A PLANET count, plus mutation minerals from SALVAGE
// (salvaging a planet means that mutation was seen on it).
// Shop-sourced mutation minerals NEVER discover. Already-baked
// false discovery (a shop mineral credited on a past load) stays —
// it is only an Index badge, and it is indistinguishable from a
// legitimate entry now, so it is not un-marked.
function deserializeState(json) {
  const freshWithBackup = (backupJson, notice) => ({
    state: freshState(),
    backupJson: backupJson || null,
    notice: notice || null,
    migrated: false,
    corrupt: true,
  });
  const unreadableNotice = 'Your save couldn\u2019t be read — backed up, starting fresh.';
  if (json === '' || json === null || json === undefined) {
    return { state: freshState(), backupJson: null, notice: null, migrated: false, corrupt: false };
  }
  let s;
  try {
    s = JSON.parse(json);
  } catch (e) {
    return freshWithBackup(typeof json === 'string' ? json : null, unreadableNotice);
  }
  if (!s || typeof s !== 'object' || (s.version !== 1 && s.version !== 2)) {
    return freshWithBackup(typeof json === 'string' ? json : null, unreadableNotice);
  }
  if (s.current !== null && (typeof s.current !== 'object' || typeof s.current.seed !== 'number' || typeof s.current.xp !== 'number')) {
    return freshWithBackup(typeof json === 'string' ? json : null, unreadableNotice);
  }
  const migrated = s.version === 1;
  if (migrated) migrateV1toV2(s);
  if (!Array.isArray(s.past)) s.past = [];
  if (typeof s.generation !== 'number' || s.generation < 1) s.generation = 1;
  if (typeof s.starterDone !== 'boolean') s.starterDone = !!s.current;
  // Step 2 fields: old saves (from before minerals existed) get
  // defaults. No starter gift anymore (round 16 overhaul — the
  // starter is gone; a pre-mineral save starts with zero minerals).
  if (!Array.isArray(s.minerals)) s.minerals = [];
  if (typeof s.mineralSeq !== 'number' || s.mineralSeq < 0) s.mineralSeq = 0;
  // Round 14: Stardust. Old saves start at 0.
  if (typeof s.stardust !== 'number' || s.stardust < 0) s.stardust = 0;
  delete s.starterMineralGranted;
  // Round 10: the Mutation Index. Old saves get it rebuilt from
  // everything still observable — mutations on the current planet,
  // on archived planets, and on SALVAGE-sourced mutation minerals
  // in the inventory (a salvaged mineral means that mutation was
  // seen on a planet). Shop-sourced minerals never discover. A
  // legacy fed mineral (feeding was cut in round 10) counts too,
  // then the fed slot is deleted — there is no fed slot anymore.
  if (!Array.isArray(s.discovered)) s.discovered = [];
  const seen = new Set(s.discovered);
  if (s.current) for (const id of (s.current.mutations || [])) seen.add(id);
  for (const p of s.past) for (const id of (p.mutations || [])) seen.add(id);
  for (const m of s.minerals) if (m.mutation && m.source === 'salvage') seen.add(m.mutation);
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
  // Round 22 (Devon, Nov 15): the 'grow' journal kind is gone —
  // reviving a planet ("Grew again") was never a story beat, so no
  // new entries are written and stored ones are stripped here, on
  // load (current + past records, snapshot or flat), so they never
  // show in the journal views again. Idempotent: a clean save has
  // nothing to strip, and the cleaned state persists on next save.
  const stripGrow = (planet) => {
    if (planet && Array.isArray(planet.journal)) planet.journal = planet.journal.filter((e) => e.kind !== 'grow');
  };
  stripGrow(s.current);
  for (const p of s.past) { stripGrow(p); stripGrow(p.planet); }
  normalizeSystem(s);
  return {
    state: s,
    backupJson: migrated ? (typeof json === 'string' ? json : null) : null,
    notice: null,
    migrated,
    corrupt: false,
  };
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
  mineralName, mineralApplyText, makeMineral,
  recordDiscovery, setDef, setsForPlanet, setMessage, attemptMutation,
  prestigeTilt, mineralSummary, yieldMineralsForPlanet, addMinerals,
  salvagePreview,
  recycleCurrent, salvageArchived, destroyCurrent,
  prestigeEligible, eligiblePrestigeParents, inheritanceBoosts,
  inheritanceOdds, lineageRecord, prestige,
  birthMutationOdds, applyOdds, wheelOdds, familyPickOdds, formatOdds,
  planetXp, planetJournal, formatRate, earnRate, eventMultiplier,
  familyComboMultiplier, familyComboDetails, earnBreakdown, systemEarnBreakdown,
  systemPlanets, systemEarnRate,
  archiveHasRoom, birthMineralIndex, payBirthCost, needPlainMineralMessage,
  salvageLostMutations, salvageLostMessage,
  buyBirthMineral, buyRandomMutationMineral, buyFamilyPick,
  mineralInventory,
  shareCardFilename, shareCardMarkdown, SHARE_REPO_URL,
  serializeState, deserializeState, migrateV1toV2,
};
