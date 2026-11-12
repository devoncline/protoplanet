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

  // How many finished planets the collection record keeps (oldest are
  // dropped first). 200 is generous; the panel (piece 4) shows them.
  PAST_LIMIT: 200,

  // How often the pet's state is written to disk while typing (ms).
  // Saves also happen immediately on stage change / new planet, so
  // nothing important is ever lost.
  SAVE_DEBOUNCE_MS: 3000,

  // --- Minerals, salvage/recycle, prestige (step 2, Nov 11) -----------
  // Mineral families map to mutation families (each mutation carries
  // tags in planet.js). A mineral tilts the NEXT planet's birth roll
  // toward matching mutations — it never changes the current planet,
  // because mutations are born with the planet (Nov 11 redesign).
  MINERAL_FAMILIES: ['moon', 'rings', 'glow', 'storm', 'sky', 'weird'],

  // Feeding multipliers (applied to CONFIG.MUTATION_CHANCE for the
  // matching mutations on the next planet's birth roll). A family
  // mineral tilts every mutation in its family; a mineral carrying a
  // specific mutation tilts that one mutation much harder.
  FED_FAMILY_BOOST_MULT: 10,
  FED_EXACT_BOOST_MULT: 20,

  // Prestige inheritance: a parent mutation passes to the offspring
  // at a multiplied chance — ~2x if one parent has it, ~3x if both.
  PRESTIGE_INHERIT_MULT_ONE: 2,
  PRESTIGE_INHERIT_MULT_BOTH: 3,

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
  // The collection is unlimited, but the solar system only DISPLAYS a
  // limited number of planets — one per orbit ring. The player picks
  // which planets occupy the rings. A "System Rank" rises as the player
  // grows finished planets; each rank unlocks +1 ring. Locked rings
  // stay visible (dashed, with their unlock requirement) — they are
  // the progression UI, not a hidden cap. No currency yet (Genshin
  // Trust Rank style, not a shop).
  SYSTEM_BASE_RINGS: 4, // rings at Rank 0
  SYSTEM_FINISHED_PER_RANK: 3, // finished planets per +1 ring
  SYSTEM_MAX_RINGS: 12, // the orrery gets unreadable past this; retune if needed

  // The one free starter mineral, granted on first run (crystal —
  // tilts toward glow effects).
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
// the planet, and they never shrink it either). A big paste counts —
// you did type it (or paste it), and the planet is made of characters.
function countInsertedChars(contentChanges) {
  let n = 0;
  for (const c of contentChanges) {
    // .length counts UTF-16 units, same as VS Code's offsets — so an
    // emoji counts as 2 XP. Harmless, and consistent with rangeLength.
    const inserted = c.text.length - c.rangeLength;
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
// `tilt` (optional, step 2) biases the birth roll — see takeTilt().
// `usedAsParent` tracks the one-time-parent rule; `parents` is the
// lineage (prestige offspring only) — always stored, so the family
// tree stays visible even if parent-fate flips to destroy.
// `takenNames` (optional Set) is the birth-time uniqueness layer:
// when a planet is born, if its base name is already used by another
// planet in the player's collection, the name is nudged (number /
// letter, seed-derived) until it is unique. The final name is stored
// on the record and never changes after birth. When no set is passed
// (tests, one-off rolls), the planet keeps its base name.
function makePlanet(seed, starterTerrain, tilt, takenNames) {
  const p = Planet.generatePlanet(seed, starterTerrain, tilt);
  if (takenNames) p.name = uniquePlanetName(p.name, seed, takenNames);
  p.xp = 0;
  p.chars = 0;
  p.usedAsParent = false;
  p.parents = null;
  return p;
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
    fedMineral: null, // the mineral fed for the NEXT planet's birth roll, or null
    mineralSeq: 0, // counter for mineral ids
    starterMineralGranted: false,
  };
}

// First run: hatch the first planet, optionally biased by the starter
// terrain the user picked (undefined = fully random). Grants the one
// free starter mineral (crystal — tilts toward glow effects).
function startFirstPlanet(state, seed, starterTerrain) {
  state.current = makePlanet(seed, starterTerrain, undefined, takenNamesFor(state));
  state.starterDone = true;
  grantStarterMineral(state);
  return state.current;
}

// ---------------------------------------------------------------------------
// Minerals (step 2) — the inventory, feeding, and the tilt.
// A mineral is { id, kind, family, mutation, source }:
//   * family: one of CONFIG.MINERAL_FAMILIES (moon/rings/glow/...).
//   * mutation: the mutation id it carries, or null for a plain family
//     mineral. A mutated planet yields a mineral OF its mutation.
//   * source: 'starter' | 'salvage' | 'prestige' (where it came from).
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

// Plain words for the UI: what does this mineral tilt toward?
function mineralTiltsText(mineral) {
  if (!mineral) return '';
  if (mineral.mutation) {
    const def = Planet.mutationDef(mineral.mutation);
    return `tilts your next planet toward ${def ? def.name : mineral.mutation}`;
  }
  return `tilts your next planet toward ${mineral.family} mutations`;
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

// Feed a mineral for the NEXT planet's birth roll. The mineral moves
// out of the inventory into the fed slot; feeding another one returns
// the old one to the inventory. The fed mineral is CONSUMED when the
// next planet is generated (recycle, new planet, prestige) —
// it never changes the planet you already have.
function feedMineral(state, mineralId) {
  const idx = (state.minerals || []).findIndex((m) => m.id === mineralId);
  if (idx < 0) return { ok: false, reason: 'no such mineral' };
  let returned = null;
  if (state.fedMineral) {
    returned = state.fedMineral;
    state.minerals.push(returned);
  }
  state.fedMineral = state.minerals.splice(idx, 1)[0];
  return { ok: true, fed: state.fedMineral, returned };
}

function unfeedMineral(state) {
  if (!state.fedMineral) return { ok: false, reason: 'nothing fed' };
  const m = state.fedMineral;
  state.fedMineral = null;
  state.minerals.push(m);
  return { ok: true, mineral: m };
}

// Take the fed mineral out of the slot (consumed by a new planet's
// birth roll). Returns the mineral, or null when nothing was fed.
function takeFedMineral(state) {
  const m = state.fedMineral;
  state.fedMineral = null;
  return m || null;
}

// The boosts map for a fed mineral: { mutationId: multiplier }.
// A family mineral tilts every mutation in its family; a mineral
// carrying a specific mutation tilts that one mutation much harder.
function boostsForMineral(mineral) {
  if (!mineral) return {};
  const boosts = {};
  if (mineral.mutation) {
    boosts[mineral.mutation] = CONFIG.FED_EXACT_BOOST_MULT;
    return boosts;
  }
  for (const mut of Planet.CONFIG.MUTATIONS) {
    if ((mut.tags || []).includes(mineral.family)) boosts[mut.id] = CONFIG.FED_FAMILY_BOOST_MULT;
  }
  return boosts;
}

// Build the tilt for the next planet: the fed mineral's boosts
// (consumed now) merged with any extra boosts (prestige inheritance).
// Multipliers stack — a mutation boosted by both is boosted by both.
// Returns null when there is nothing to tilt (plain birth roll).
function takeTilt(state, extraBoosts) {
  const boosts = boostsForMineral(takeFedMineral(state));
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
    fed: state.fedMineral ? mineralName(state.fedMineral) : null,
  };
}

// ---------------------------------------------------------------------------
// Salvage / recycle (step 2) — destroying planets for minerals.
// ---------------------------------------------------------------------------

// What a destroyed planet yields. One mineral per mutation it carries
// (each carrying that mutation — the mineral remembers where it came
// from); a plain planet yields one plain mineral of a family derived
// from its own seed, so the yield is stable and testable.
function yieldMineralsForPlanet(planet) {
  const yields = [];
  const muts = planet.mutations || [];
  if (muts.length > 0) {
    for (const id of muts) {
      const def = Planet.mutationDef(id);
      yields.push({ family: (def && def.tags && def.tags[0]) || 'weird', mutation: id, source: 'salvage' });
    }
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
// planet's birth roll is tilted by any fed mineral (consumed).
// Generation +1 — a recycled planet is a new life.
function recycleCurrent(state, nextSeed) {
  if (!state.current) return { ok: false, reason: 'no current planet' };
  const destroyed = state.current;
  const minerals = addMinerals(state, yieldMineralsForPlanet(destroyed));
  state.generation += 1;
  const tilt = takeTilt(state, null);
  state.current = makePlanet(nextSeed ? nextSeed() : randomSeed(), null, tilt, takenNamesFor(state));
  // The destroyed planet may have been on a ring — clear that slot.
  normalizeSystem(state);
  return { ok: true, minerals, destroyedSeed: destroyed.seed, planet: state.current };
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
      seed: state.current.seed, generation: state.generation,
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
  for (const [id, n] of Object.entries(count)) {
    boosts[id] = n >= 2 ? CONFIG.PRESTIGE_INHERIT_MULT_BOTH : CONFIG.PRESTIGE_INHERIT_MULT_ONE;
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
// parents' mutations (inheritance) plus any fed mineral (consumed).
// The offspring becomes the new current planet; the old current
// planet is archived (retired if it was a parent, plain if not) —
// unless the parents were destroyed instead (flag). Parents STAY in
// the collection by default, but each can only be a parent ONCE.
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
  const genA = parentA.kind === 'current' ? state.generation : a.generation;
  const genB = parentB.kind === 'current' ? state.generation : b.generation;
  const parents = [lineageRecord(a, genA), lineageRecord(b, genB)];
  const currentIsParent = parentA.kind === 'current' || parentB.kind === 'current';
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
  // The old current planet leaves the stage — archived (retired if it
  // was a parent) — unless it was just destroyed as a parent.
  if (state.current && !(CONFIG.PRESTIGE_CONSUMES_PARENTS && currentIsParent)) archiveCurrent(state);
  const tilt = takeTilt(state, inheritanceBoosts(mutsA, mutsB));
  state.generation += 1;
  const offspring = makePlanet(nextSeed ? nextSeed() : randomSeed(), null, tilt, takenNamesFor(state));
  offspring.parents = parents;
  state.current = offspring;
  return { ok: true, planet: offspring, parents };
}

// Move the current planet into the collection record. The record
// keeps a FULL snapshot of the planet (`planet`) — every trait the
// renderer needs (rings, moons, size, mutation-granted traits like
// ringHue) — because re-rolling from the seed alone cannot reproduce
// a tilted birth roll. Flat fields stay for backwards compatibility
// and for the tests that read them.
function archiveCurrent(state) {
  if (!state.current) return;
  const c = state.current;
  state.past.push({
    seed: c.seed,
    name: nameForPlanet(c),
    terrain: c.terrain,
    terrainLabel: c.terrainLabel,
    summary: c.summary,
    chars: c.chars,
    generation: state.generation,
    archivedAt: Date.now(),
    mutations: (c.mutations || []).slice(),
    parents: c.parents ? c.parents.map((p) => ({ ...p, mutations: (p.mutations || []).slice() })) : null,
    usedAsParent: !!c.usedAsParent,
    planet: JSON.parse(JSON.stringify(c)),
  });
  while (state.past.length > CONFIG.PAST_LIMIT) state.past.shift();
  normalizeSystem(state);
}

// ---------------------------------------------------------------------------
// Solar system (step 4) — the collection view's slots and ranks.
// The collection (state.past) is unlimited; the solar system
// (state.system) only DISPLAYS one planet per orbit ring. A slot is
// null (empty) or { seed, generation } — looked up by seed+generation
// so it survives the planet moving between current and archived.
// ---------------------------------------------------------------------------

// Finished planets = archived planets. The current (growing) planet
// does not count — a rank is earned by FINISHING planets.
function finishedCount(state) {
  return (state.past || []).length;
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
  if (state.current && state.current.seed === slot.seed && state.generation === slot.generation) {
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
    || (state.current && state.current.seed === seed && state.generation === generation);
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
function applyXp(state, n, nextSeed) {
  if (!state.current || n <= 0) {
    return {
      stageChanged: false,
      rebirthed: false,
      becameMax: false,
      stageIdx: state.current ? stageForXp(state.current.xp) : 0,
    };
  }
  const before = stageForXp(state.current.xp);
  state.current.xp += n;
  state.current.chars += n;
  const after = stageForXp(state.current.xp);
  return {
    stageChanged: before !== after,
    rebirthed: false,
    becameMax: before < DISPLAY_STAGE_MAX && after >= DISPLAY_STAGE_MAX,
    stageIdx: after,
  };
}

// "New planet" command: archive the living planet (if any) and hatch a
// fresh one. Generation +1 — a manual new planet is a new life, on
// demand. A fed mineral tilts the new planet's birth roll (consumed).
function newPlanet(state, nextSeed) {
  if (state.current) archiveCurrent(state);
  state.generation += 1;
  state.current = makePlanet(nextSeed ? nextSeed() : randomSeed(), null, takeTilt(state, null), takenNamesFor(state));
  return state.current;
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
function makeSeedPlanet(seed, takenNames, terrain) {
  const p = Planet.stripMutations(Planet.generatePlanet(seed, terrain || undefined));
  if (takenNames) p.name = uniquePlanetName(p.name, seed, takenNames);
  p.xp = 0;
  p.chars = 0;
  p.usedAsParent = false;
  p.parents = null;
  return p;
}

// "Hatch from seed" command: archive the living planet (kept in the
// collection) and hatch the seed's base planet, mutations stripped.
// Generation +1 — a seed-hatched planet is a new life, on demand.
// NO tilt is applied: a fed mineral would change the planet away
// from the seed's canonical form, so the fed mineral stays fed for
// the next birth that actually rolls (new planet / recycle /
// prestige). When there is no current planet yet (first run), the
// seed hatch IS the first planet (starter done + the one free
// starter mineral), so the first-run pick never pops up afterwards.
function hatchFromSeed(state, seed, terrain) {
  if (state.current) {
    archiveCurrent(state);
    state.generation += 1;
  } else if (!state.starterDone) {
    state.starterDone = true;
    grantStarterMineral(state);
  } else {
    state.generation += 1;
  }
  state.current = makeSeedPlanet(seed, takenNamesFor(state), terrain);
  return state.current;
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
    if (typeof s.fedMineral !== 'object') s.fedMineral = null;
    if (typeof s.mineralSeq !== 'number' || s.mineralSeq < 0) s.mineralSeq = 0;
    if (typeof s.starterMineralGranted !== 'boolean') {
      s.starterMineralGranted = true;
      if (s.minerals.length === 0) s.minerals.push(makeMineral(s, CONFIG.STARTER_MINERAL));
    }
    // Step 4 fields: old saves get an empty 4-ring system.
    if (!Array.isArray(s.system)) s.system = [null, null, null, null];
    normalizeSystem(s);
    return s;
  } catch (e) {
    return freshState();
  }
}

module.exports = {
  CONFIG, COUNTED_SCHEMES,
  shouldCountDocument, countInsertedChars,
  stageForXp, stageInfo, displayStageForXp, isMaxed,
  randomSeed, makePlanet, nameForPlanet, uniquePlanetName, takenNamesFor, freshState, startFirstPlanet,
  archiveCurrent, applyXp, newPlanet, parseSeedInput, makeSeedPlanet, hatchFromSeed, shareSeedFor,
  finishedCount, systemRank, lockedRingLabel, resolveSlotPlanet,
  slotIndexForPlanet, normalizeSystem, placePlanet, removeFromSystem,
  mineralName, mineralTiltsText, makeMineral, grantStarterMineral,
  feedMineral, unfeedMineral, takeFedMineral, boostsForMineral, takeTilt,
  mineralSummary, yieldMineralsForPlanet, addMinerals,
  recycleCurrent, salvageArchived,
  prestigeEligible, eligiblePrestigeParents, inheritanceBoosts,
  lineageRecord, prestige,
  shareCardFilename, shareCardMarkdown, SHARE_REPO_URL,
  serializeState, deserializeState,
};
