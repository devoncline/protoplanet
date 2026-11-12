# Mutation list — Protoplanet (decided with Devon, Nov 11, 2026)

Keep this list current. Devon asks for it on demand — send him this list.

## Mutations (inheritable traits — the rarity system)

- **Green Moon** — a moon that glows neon green. (Devon's pick.)
- **Blood Moon** — a red moon. Same colored-moon family as Green Moon; other colors possible.
- **Crystal Crust** — the surface sparkles. QUALITY BAR: sparkles must look intentional and pretty, NOT like a glitched-out planet.
- **Crossed Rings** — two rings at different angles crossing over each other.
- **Glowing Oceans** — oceans glow on the night side.
- **Giant Storm** — Jupiter-style storm with an eye that travels.
- **Comet** — passes by periodically.
- **Meteor Shower** — streaks falling across the planet every so often.
- **Sparkling Surface** — the surface sparkles.
- **Big Moon** — one oversized moon.
- **Colored Rings** — rings in a color (not the default gold).
- **Double Rings** — two parallel rings.
- **Glitch** — the planet looks glitched. Non-realistic, intentionally broken. Must look CLEARLY different from Crystal Crust's pretty sparkles.

## Cut (do not build)

- **Twin Suns** — two light sources, too confusing to read.
- **Binary Star** — same two-light problem as Twin Suns.
- **Ringed Moon** — moons are too small for a ring to read.
- **Eclipse** — Devon doesn't like it.
- **Glow effect** — real bloom doesn't work in ASCII; skipped by agreement.
- **Aurora Crown** — Devon not a fan (Nov 11, 4:20 PM): just text, no glow, would look clunky. Removed.
- **City Lights** — Devon, Nov 11: city lights are the Civilization STAGE feature, not a mutation — having it as a mutation too was confusing and wrong. Removed (the stage-6 city-lights sparkles stay).

## Base rarity (NOT mutations)

A planet that is naturally crazy-looking — huge size, multiple rings — is
rarer in generation, but it is NOT a mutation. Rarity from generation
(size/ring combos) is separate from the mutation system.

## Rarity display

When a mutation rolls, show it BIG in the pet window: the mutation name
with a MUTATION tag as a prominent label (e.g. "MUTATION · Green Moon"),
plus in the status bar. A mutation you can't see is worthless. (Wired
into the extension window + status bar Nov 11: the tag shows from
stage 0, hidden when the planet has none.)

## Cross-stage (verified Nov 11)

Every mutation reads on ALL 7 stages, adapted per stage — not identical.
Moons, comet, meteor shower and glitch show from stage 0; sparkles and crystals from stage 1
(the core's own sparkles carry stage 0); rings, oceans and the storm
from stage 4, when those traits exist at all. Before a trait exists the
mutation is label-carried only (no rings before stage 4, no oceans
before stage 4).

## Tiers (default, renameable after playing)

NO TIERS (Devon, Nov 11, 2:27 PM): all mutations are on one tier — all
just really rare mutations, roughly equal rarity. No Common→Legendary.
The window shows the mutation name with a MUTATION tag, no tier.

## Rolls — born with it (Devon, Nov 11, 2:27 PM)

Mutations roll AT GENERATION (birth) and are visible from stage 0 — not
on evolutions. The player sees the mutation right away and decides
whether to keep growing the planet or destroy it for minerals to make a
new one (the recycle loop). The destroy-for-minerals mechanic itself is
step 2 (minerals system).

## Odds (all tunable in one CONFIG in planet.js)

Default: about 1 in 10 planets is born with a mutation (~10% any
mutation, each mutation roughly equal chance). Most planets have NO
mutation — when one shows up, it's special. 72% (the old per-evolution
model) was too many. Retune after playing. Measured over 10,000 seeds
(Nov 11, after the City Lights cut): 9.0% any mutation, 0.46% two
mutations, each mutation 0.63–0.85%. One knob: `CONFIG.MUTATION_CHANCE` (0.007).

## Minerals (BUILT — step 2, Nov 11)

The player starts with one free mineral (crystal — tilts toward glow
effects), granted on first run. Inventory lives in petLogic state
(`state.minerals`, persisted in globalState); old saves get the
starter mineral as a one-time gift on load.

**Feeding (birth-roll rethink — settled):** mutations are born with
the planet, so feeding a mineral does NOT change the current planet.
Feeding tilts the NEXT planet's birth roll toward matching mutations.
Feed any time (Command Palette: "Feed a mineral"); the fed mineral
sits in the fed slot and is CONSUMED when the next planet is
generated — recycle, new planet, or prestige offspring.
Feeding another mineral returns the old one to the inventory.
A family mineral tilts every mutation in its family (x10); a mineral
carrying a specific mutation tilts that one mutation harder (x20).
All multipliers live in petLogic CONFIG, tunable.

Mineral families: moon / rings / glow / storm / sky / weird (each
mutation carries tags for the mapping).

## Salvage / recycle (BUILT — step 2, Nov 11)

Destroy ANY planet for minerals — this is Devon's loop: roll a
planet, see its mutation at birth, keep it or recycle it for
minerals and roll again.

- **Recycle the CURRENT planet** (Command Palette: "Salvage /
  recycle a planet"): destroyed for minerals AND a fresh planet
  hatches immediately (generation +1). The destroyed planet is NOT
  archived — it's gone, its minerals are what you keep. A fed
  mineral tilts the fresh planet's birth roll.
- **Salvage an ARCHIVED planet:** destroyed for minerals, no new
  planet.

Yields: one mineral per mutation the planet carries (each carrying
that mutation — the mineral remembers where it came from); a plain
planet yields one plain mineral of a family derived from its own
seed. The mineral count shows in the status bar (◆N) and the pet
window's meta line, plus any fed mineral ("Fed: Crystal mineral").

## Prestige (BUILT — step 2, Nov 11; word kept — Devon's lean)

Combining two planets that REACHED Civilization (2200+ chars —
"reached", so a maxed planet that kept growing past 2200 counts too) makes an offspring: a
new seed starting as dust, whose birth roll is tilted by the
parents' mutations — each parent mutation passes at a multiplied
chance (~2x if one parent has it, ~3x if both); mutations neither
parent has still roll at the base chance. A fed mineral stacks on
top (consumed). The offspring becomes the new current planet; the
old current planet is archived. Command Palette: "Prestige two
planets" (two-step pick, then confirm).

**Parent fate — built as a tunable switch.**
Devon's dilemma: destroy the parents and you lose a lot of planets;
keep them and prestiging is a no-brainer. **Build default: parents
STAY in the collection/solar system forever, visible with their stats —
BUT each planet can only be a parent ONCE.** After prestiging, a parent
is "retired": it keeps its place, it just can't be a parent again.
That way nothing is ever lost, prestiging is still a real decision
(which pair, and when), and you make more prestiges by growing more
planets. The flag is `PRESTIGE_CONSUMES_PARENTS: false` by default in
petLogic CONFIG — flip it to destroy-parents later if he decides that. If the
flag ever flips, the collection keeps a permanent record of each
destroyed planet (name, stats, "grown from N characters") plus a
mineral payout, so nothing is truly lost.

**His real lean is DESTROY for realism** (accepted retire for now):
two planets merge together, they get the mutations because they're
still together in space, but both can't exist if the kid exists.
**Synthesis: the offspring's record always stores its parents (their
names/seeds/stats)** — so if the flag flips to destroy/merge, the
child's record carries the lineage and the family tree stays visible
even though the parent planets are gone. Merge is realistic, lineage
keeps the memory.

## Second planet (flag for Devon)

The New planet command (manual — old planet archived, new seed
starts) IS the current path to a second planet — but that means two
full planets before the first prestige. That grind is long. (Auto-
rebirth at 3,600 XP used to be the path; cut Nov 12.) Recycle is NOT a
shortcut here: it replaces the current planet, it doesn't give you
two at once. Ask him if he wants a faster second-planet route; do
not invent one on your own.

## Onboarding (step 3 — NOT built yet)

First run: a curated pick — pick 1 of 3 starter minerals, each with a
one-line flavor hint of what it tilts toward. A fun, limited, hook-y
first choice, NOT a shop menu. The starter mineral feeds into the
mineral system above. Until onboarding lands, the starter mineral
(crystal) is granted automatically on first run.
