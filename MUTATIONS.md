# Mutation list — Protoplanet (decided with Devon, Nov 11, 2026; reworked Nov 12)

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

## Minerals (BUILT — step 2, Nov 11; reworked round 10, Nov 12)

The player starts with one free mineral (crystal — glow family),
granted on first run. Inventory lives in petLogic state
(`state.minerals`, persisted in globalState); old saves get the
starter mineral as a one-time gift on load.

**Apply (round 10 — the mineral IS the mutation; feeding is gone):**
Devon, Nov 12: feeding a mineral to tilt the NEXT planet's birth roll
was "confusing and clunky". Replaced. Now you spend a mineral on the
planet you already love — Command Palette: "Protoplanet: Apply a
mineral to your planet". The pick list only shows minerals that CAN
go on this planet (one already on it, or a family it already owns
whole, is not offered). Then a coin flip (`CONFIG.MUTATE_CHANCE`,
0.5): it takes hold, or it fizzles and the mineral is gone either
way. A mutation mineral tries THAT mutation; a family mineral tries
a random mutation in its family the planet doesn't already have.
Success bakes the exact same visuals a planet born with that
mutation would have (same shared code, seeded per planet +
mutation, so it always looks the same way). The sidebar flashes
gold on the new mutation label, and the toast names it
("✦ Green Moon took hold on GJ-1281e!"). A blocked mineral is
never consumed. No preview of the mutation before it lands — the
surprise is the fun (Devon: he once glitched a planet randomly,
thought it was broken, realized it was mutated — "felt awesome").

**Seed protection:** a shared seed hatches the SAME base planet
WITHOUT mutations (seed hatch strips them). Nobody gets your rare
mutated planet just by pasting its seed — mutations stay unique to
the original. A mutation mineral only comes from destroying a
planet that had the mutation.

Mineral families: moon / rings / glow / storm / sky / weird (each
mutation carries tags for the mapping).

## Sets (BUILT — round 10, Nov 12)

A whole mutation family on ONE planet names it — the set is the
planet's title, not a separate reward.

- **Moon Lord** — Green Moon + Blood Moon + Big Moon on one planet.
- **Ring King** — Crossed Rings + Colored Rings + Double Rings on one planet.

Completing a set fires a toast ("GJ-1281e is the Moon Lord!") and
the set gets its own gold title card in the detail sheet and in
the Mutation Index.

## Mutation Index (BUILT — round 10, Nov 12)

The Solar System panel's third tab. Every mutation you have ever
found is recorded forever (`state.discovered`) — even after the
planet is destroyed. Found entries are gold with ✦, the name, the
family, the odds ("about 1 in 143 births"), and which planets carry
it now ("On: GJ-1281e" — or "Found — but its planet is gone.").
Missing entries are dimmed with ? and the same odds. The sets row
on top names each set, what it needs, and who holds it
("Held by GJ-1281e" / "Not earned yet."). The Index itself can be
filtered (All / Mutated only / one mutation) and sorted by "Most
mutated".

## Legendary look (BUILT — round 10, Nov 12)

Mutated planets read as legendary everywhere:

- **Sidebar:** the mutation label flashes gold for 2s on a new
  mutation (birth or apply) and the planet flickers once.
- **Index tiles:** a mutated planet's tile gets a gold outline and
  a ✦ in the top-right corner (✦×N when it carries several).
- **Detail sheet:** every mutation is its own gold title card
  (✦ name + one-line flavor), and a completed set gets its own
  set title card — instead of the old flat .mut tag.

## Salvage / recycle (BUILT — step 2, Nov 11; perk added round 10)

Destroy ANY planet for minerals — this is Devon's loop: roll a
planet, see its mutation at birth, keep it or recycle it for
minerals and roll again.

- **Recycle the CURRENT planet** (Command Palette: "Salvage /
  recycle a planet"): destroyed for minerals AND a fresh planet
  hatches immediately (generation +1). The destroyed planet is NOT
  archived — it's gone, its minerals are what you keep.
- **Salvage an ARCHIVED planet:** destroyed for minerals, no new
  planet.

Yields: one mineral per mutation the planet carries (each carrying
that mutation — the mineral remembers where it came from) **plus
one extra plain mineral** if the planet was mutated at all (round
10 perk — a mutated planet is worth more); a plain planet yields
one plain mineral of a family derived from its own seed. The
mineral count shows in the status bar (◆N) and the pet window's
meta line. A destroyed planet's mutations stay discovered in the
Mutation Index.

**System Rank weight (round 10):** a double-rings planet counts
double toward System Rank (finished planets / 3) — a double ring
is a whole second ring system, so it fills a ring slot's worth of
"finished" faster.

## Prestige (BUILT — step 2, Nov 11; % preview added round 10)

Combining two planets that REACHED Civilization (2200+ chars —
"reached", so a maxed planet that kept growing past 2200 counts too) makes an offspring: a
new seed starting as dust, whose birth roll is tilted by the
parents' mutations — each parent mutation passes at a real chance
(50% if one parent has it, 75% if both — Devon's call, Nov 12:
inheritance is genetics, not a lottery ticket); mutations neither
parent has still roll at the base chance. The offspring becomes the
new current planet; the old current planet is archived. Command Palette: "Prestige two
planets" (two-step pick, then confirm).

**The % before you commit (round 10 — the Brainrot fuse screen):**
the prestige panel shows the REAL chance per parent mutation
before fusing — "◆ Glowing Oceans — one parent carries it ·
50% (base 0.7%)" — plus "Anything else can still appear at its
usual rare odds — 0.7% each." No fed mineral stacks on top anymore
(feeding is gone; inheritance is the only tilt).

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

## Economy (PARKED — Phase 2, Devon Nov 12)

Once a planet reaches Civilization it has an economy, and a heavily
mutated planet earns more — a reason to farm mutations beyond
showing off. Held off until the mutation rework above is in place
and feels good. Do not build until Devon says so.

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
one-line flavor hint of what it could become. A fun, limited, hook-y
first choice, NOT a shop menu. The starter mineral is your first
mutate attempt. Until onboarding lands, the starter mineral
(crystal) is granted automatically on first run.
