# Piece 3 brief — mutations (PLANNING ONLY, no code yet)

> **UPDATE — Nov 11, 2:27 PM (Devon's redesign, implemented same day):**
> the per-evolution roll + tier model in this brief is SUPERSEDED. No
> tiers; mutations roll AT GENERATION (birth) at one shared chance
> (`CONFIG.MUTATION_CHANCE` = 0.007, ~10% of planets); visible from
> stage 0; label is "MUTATION · Name". Shattered Belt cut. Aurora Crown
> CUT (Devon, Nov 11, 4:20 PM — just text, no glow, would look clunky).
> Cross-stage matrix verified (all 14 mutations read on all 8 stages).
> The live design is in `MUTATIONS.md` and
> `planet.js` — this brief is the phase-1 record only.
>
> **UPDATE — Nov 11, step 2 (minerals + salvage/recycle + prestige,
> BUILT same day):** minerals inventory in petLogic (one free starter
> crystal on first run); feeding tilts the NEXT planet's birth roll
> (family x10, exact mutation x20, consumed on generation); recycle
> destroys the current planet for minerals and hatches a fresh one;
> salvage destroys archived planets for minerals; prestige combines
> two Civilization-reached (2200+ chars) planets into an offspring
> with 2x/3x inheritance, parents stay but can only parent once
> (`PRESTIGE_CONSUMES_PARENTS: false`), offspring always stores its
> parents (lineage). Commands in the Command Palette; mineral count
> in the status bar + pet window. No Space port, no onboarding yet —
> those are later steps. Tests: test-planet 160, test-pet 200.

Piece 3 is **gated**: it starts only after Devon has lived with piece 2
(the extension shell + typing XP) and says go. This doc captures the
design as settled with him on Nov 10, 2026, plus the open questions he
still has to decide. Nothing here is built yet.

## Where things stand

- **Piece 1 (done, approved):** `planet.js` — seeded generator (10
  terrains, ring types, 0–3 moons; same seed = same planet) + JS
  renderer, bit-exact vs `lifecycle.py`. `preview.html` + 28 PNG samples.
- **Piece 2 (done, Devon testing Nov 11):** the extension shell —
  sidebar pet window, typing = XP (1 char = 1 XP; thresholds
  0/100/300/600/1000/1500/2200/3000; rebirth at 3600 XP), first-run
  starter pick, status bar, `globalState` persistence, no popups.
- **Rules that carry forward:** ambient, never interrupting (no popups
  while typing); fixed-size cells for ALL HTML rendering (never a bare
  `<pre>` — see README); plain JS, no build step; no network calls; no
  Marketplace publishing until Devon says go.

## The settled design — mutations

Mutations are **inheritable traits**: special visual effects a planet
can be born with or roll on an evolution. They are the rarity system.

**Mutation list (settled as candidates, final list TBD — see open
questions):**
- big moon
- colored rings
- double rings
- shattered ring (asteroid belt)
- aurora lights (poles)
- sparkling surface
- glowing oceans
- giant storm (Jupiter-style)
- comet (passes by periodically)
- binary star (two light sources)
- city lights (night side)

**How they work:**
- **Rolls:** on each evolution, a luck roll for a mutation, with
  **weighted odds** — common mutations show up a lot, rare ones barely
  ever. Shiny-Pokémon style: a small chance of a cool effect on any
  evolution. All odds live in one tunable `CONFIG` (like the XP
  thresholds in `petLogic.js`).
- **Tiers are labels, not the system:** Common → Legendary (or whatever
  names Devon picks) are derived from a planet's mutations — a planet
  with a comet is Rare because comets are rare, not because we decided
  it. Labels are renameable after playing.
- **Minerals tilt the dice:** feeding a mineral before an evolution
  raises the odds of matching mutations (e.g. crystal → glow effects).
  Minerals are not decoration — they change your luck.
- **Salvage:** destroying a planet gives mineral pieces. A planet with
  a rare mutation yields a **better mineral** — a mineral carrying that
  mutation, which can be fed to another planet to raise its odds of
  rolling it. This is the answer to "why not destroy everything":
  destroy = minerals now, keep = mutations for breeding later. Keep
  what you want to breed, destroy what you don't.
- **Prestige:** combine two Civilization-stage planets → a new planet
  (new seed, starts as dust, grows by typing). **Inheritance:**
  each parent mutation has a **multiplied** chance to pass to the
  offspring — one parent has it = boost (~2× base odds), both parents
  have it = bigger boost (~3×). **Parents stay in the collection** as a
  record — combining never deletes what you made.
- **Collection:** finished planets live in a record (the full solar
  -system panel is piece 4). Piece 3 must at least store mutations in
  the archived record and show the current planet's mutations in the
  pet window / status bar — a mutation you can't see is worthless.

**Flavor (settled):** the planet is made of the characters you type —
each keystroke is matter. The collection shows "grown from N
characters" on each planet.

## Design polish — the reel-style look (DONE Nov 11)

Devon (Nov 10, 11:59 PM) wanted a **design polish pass** on how the
planets look, modeled on the style of the original reel
(https://www.instagram.com/reel/DfktA7npLdV/ — frame study in
`~/workspace/reel-DfktA7npLdV.md`). What he likes about the reel:
faded characters around the edges, little lighting effects, smoother
overall, **bigger planets with smaller characters** — more detail,
which also gives mutations more room to show. **Not a copy, just the
style** — he likes what we have now, it just needs to look better.

**DONE Nov 11 (Devon asked to keep working that night):** the JS
renderer was restyled — grid 136×76 (was 100×48), stage radii ×1.5
(Civilization disc now 57 cells wide, was 38), atmospheric limb fade
(edges dissolve into black), softer light (half-strength smoothstep),
thin bright rim, irregular edge, denser rings, city lights kept off
the faded limb. Seeded generation UNCHANGED (same seeds = same
planets); the JS renderer is now the look authority and intentionally
diverges from `lifecycle.py` (the bit-exact fidelity check was retired
by design — see `test-planet.js`). Mutations (piece 3) get designed
onto this new look.

**Window-size rule (Devon, Nov 11, 12:01 AM):** the planet must NEVER
crop when the window shrinks — cropping ruins the "characters make up
the planet" idea. Answer: re-render the same planet at a **lower
resolution** in small windows (fewer, bigger characters — still a whole
planet made of readable characters) and save full detail for the big
panel. Scaling glyphs down has a floor. Piece 2's sidebar currently
scales cells down instead (glyphs get tiny at sidebar width) — the
lower-resolution render is the fix, folded into the panel piece
(piece 4). This interacts with the polish direction above: high
resolution in the big panel, low resolution re-render in small windows.

## Open questions — Devon decides before piece 3 starts

1. **Exact tier names:** Common → Legendary, or different names?
   (Labels only — but they show in the UI, so pick ones he likes.)
2. **Final mutation list:** the 11 candidates above — keep all, cut
   any, add any cooler ones? (He already likes big moon, glowing
   oceans, giant storm, comet best.)
3. **Exact odds:** how rare is rare? (Suggested starting point: a
   common mutation ~1-in-8 evolutions, a legendary one ~1-in-100 —
   tune after playing.)
4. **Mineral → mutation mapping:** which mineral tilts which
   mutation(s)? And how do you earn minerals before salvage exists?
   (Starter minerals? A first free one?)
5. **Prestige requirements:** must both parents be Civilization-stage,
   or can any finished planet prestige? What does the offspring cost
   (anything, or free)?
6. **Salvage details:** does destroying a planet with NO mutation give
   anything (plain pieces)? Can you destroy the CURRENT planet, or
   only archived ones?
7. **Order:** answered — design polish first (done Nov 11), then
   mutations. The polish already landed, so piece 3 designs mutations
   onto the new 136×76 look.

## What piece 3 will touch (when it starts)

- `planet.js`: mutation visuals in the renderer (each mutation is a
  visible effect on the planet) + mutation rolls in the generator.
  Higher grid resolution lands here too IF the polish piece goes
  first.
- `petLogic.js`: mutation state on the planet, evolution rolls,
  mineral inventory + feeding, salvage, prestige — all in the tunable
  `CONFIG`.
- `extension.js`: show mutations in the pet window / status bar;
  commands for feed mineral / salvage / prestige (panel UI is piece 4,
  so piece 3 commands live in the Command Palette + status bar for now).
- Tests: `test-pet.js` gains mutation-odds, inheritance, salvage and
  prestige checks; `test-planet.js` gains render checks for each
  mutation effect.
