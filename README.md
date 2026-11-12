# Protoplanet — a VS Code extension (in progress)

A coding pet for VS Code: as you type, a little ASCII planet grows —
through an 8-stage lifecycle (dust → rock →
world → civilization → end — no automatic rebirth). Typing is the fuel: the planet
is made of the characters you type.

**Built in polished pieces, one at a time.** Devon reviews each piece
before the next one starts. Nothing is published to the Marketplace yet.

## Piece 1 — seeded generator + renderer (DONE)

The foundation everything else depends on.

- **`planet.js`** — plain JS, no dependencies, no build step. Two parts:
  - **Seeded generator:** a number (seed) → a unique planet, every time.
    Same seed = same planet, forever. A deterministic PRNG (mulberry32)
    rolls the traits: terrain (icy, lava, jungle, rocky, ocean, desert,
    crystal, toxic, gas, metal), atmosphere color, ring type (none / thin /
    wide / double / colored ice / shattered), moons (0–3), size. No AI —
    just an algorithm, No Man's Sky style. Devon designs the trait lists,
    the algorithm does the combining.
  - **Renderer:** started as a faithful port of `../lifecycle.py` —
    same ramp, same fixed top-left light, same spin illusion (glyph
    flicker + texture drift), same ring math (orbiting brightness wave,
    3D shading, planet shadow, Cassini gap). **Restyled Nov 11 toward
    the reel's look** (Devon asked to keep working that night): grid
    136×76 (was 100×48), stage radii ×1.5 (Civilization disc now 57
    cells wide, was 38), atmospheric limb fade (edges dissolve into
    black), softer light, thin bright rim, irregular edge, denser
    rings. The JS renderer is now the **look authority** — it
    intentionally diverges from `lifecycle.py`, which stays as the
    original Python loop. Same seeds still produce the same planets;
    only the drawing changed. Terrain bands replace the stage's default
    bands, so each planet keeps its own colors through every stage.
    Ring types change the drawing: double draws two bands with a real
    gap, colored uses ice-cyan rings, shattered widens the gap and
    frays the edge. Moons orbit the planet.
- **`CONFIG`** at the top of `planet.js` holds every tunable number —
  terrain colors + weights, atmosphere colors, ring types, moon odds,
  size range — with comments. Tweak there.
- **`preview.html`** — open it in a browser to SEE the variety: ten
  showcase planets (one per terrain, animated), one planet across all
  7 stages, and a "Roll a new planet" button for a fresh random seed.
- **Tests:** `node test-planet.js` — determinism (same seed → same
  planet, same render → identical grid), variety (500 seeds cover all
  10 terrains, 6 ring types, moon counts 0–3), starfield match, and
  roundness (the rendered disc displays as a circle, ratio near the
  approved ~1.11, and is bigger than the old 100×48 disc). The old
  cell-for-cell fidelity check vs `lifecycle.py` was **retired by
  design** when the renderer was restyled (Nov 11) — the JS renderer
  is the look authority now and is supposed to differ from the Python
  loop. Do not re-add it.

```bash
node test-planet.js        # run the checks
node pick-samples.js       # pick a diverse showcase set of seeds
python3 make-samples.py    # redraw the PNG stills (after dump-samples.js)
```

## Piece 2 — extension shell + typing XP (DONE)

The actual VS Code extension. Open the folder in VS Code and press **F5**
(Extension Development Host) to run it, or `npx @vscode/vsce package`
then **Install from VSIX**. Nothing is published to the Marketplace.

- **`package.json`** — publisher `devoncline`, name `protoplanet`, activates
  on startup. Contributes a pet view as a collapsible section in the
  Explorer (no separate Activity Bar icon), plus commands **Protoplanet: Show pet**
  and **Protoplanet: New planet** (asks first; the old planet is kept in
  the collection record). A "New planet" button also sits in the view's
  title bar.
- **`petLogic.js`** — the pure logic, no `vscode` import, tested in plain
  Node (`node test-pet.js`, 110 checks). Typing = XP (1 inserted char =
  1 XP; deletions earn nothing; undo/redo and non-text documents like
  the output panel earn nothing). XP grows the planet through the 7
  stages — thresholds `0 / 100 / 300 / 600 / 1000 / 1500 / 2200`,
  then no automatic rebirth: past the last stage the planet just keeps
  gaining XP indefinitely. A new planet only starts when the player
  asks for one (New planet command, recycle, prestige) — the old
  planet is archived, generation +1. At Civilization (2200+ XP) the
  XP bar turns orange and a one-time prompt offers a new planet.
  First run asks for a starter terrain (icy / lava / jungle / rocky /
  ocean), which biases the first planet's seed. All numbers live in one
  `CONFIG` object at the top of `petLogic.js`.
- **`extension.js`** — VS Code wiring only: sidebar webview, status bar
  (globe icon + `Oceans · 640/1000 XP`, click to show the pet), `globalState`
  persistence (one key, debounced 3s while typing, immediate on stage
  change / new planet). **Ambient:** no popups while typing —
  evolutions show in the pet window and status bar only (one
  exception: a single prompt when the planet first reaches
  Civilization, offering a new planet).
- **The pet window** reuses `planet.js`'s `gridToHtml()` + the
  fixed-size-cell CSS from the piece-1 fix (10:18 ratio, `text-size-adjust:
  none`, runtime font measurement, nonce CSP). It animates at ~7 fps and
  shows stage name + description, an XP bar, and "grown from N
  characters". The sidebar is narrow, so cells scale down to fit — the
  glyphs get tiny, but the planet's shape, colors, rings and motion
  still read. A full-size view is piece 4's panel.
- **The look is tunable, not baked in:** terrain colors, bands and ring
  styles live in the `CONFIG` object in `planet.js`, separate from the
  generator — changing how a planet looks is changing values, not
  rebuilding. A design polish pass is a later piece, after living with
  the pet a while.
- **Tests:** `node test-pet.js` — 509 checks (XP counting, stage
  boundaries, no-auto-rebirth + orange max bar, starter bias, new-planet
  command, persistence round-trip, bad-data fallback, minerals /
  salvage / prestige, System Rank / slots / overflow, package.json
  contract, share card, seed hatch). Plus a wiring harness
  (`../scratch/test-system-panel.js`, fake `vscode` module) that
  loads `extension.js` for real and drives activation, typing
  events, status bar, webview messages and the generated HTML,
  including opening the Solar System panel and driving place /
  remove through it: 33 checks, all passing.
- **Not verified here:** the Extension Development Host can't run
  headless on this VM — Devon runs it with F5 on his PC. That's the
  real test.

## Step 4 — Solar System / collection view (DONE Nov 11)

Command: **Protoplanet: Open solar system** (`protoplanet.openSolarSystem`).

A full-screen webview panel, tilted orrery at the top and the
Pokédex/Archive below it. The star sits in the middle (default star
for now — no rarity or upgrades yet); one ring per unlocked slot, one
planet per ring. Orbit rings are ellipses (tilt 0.42) while the planet
discs stay upright, facing the viewer — the Stellaris-style tilted
view Devon asked for, not top-down and not pure side view.

- **Slots / System Rank:** 4 rings at Rank 0. Each rank unlocks +1
  ring (Rank = floor(finished planets / 3), capped at 12 rings).
  Locked rings are visible as dashed rings with the unlock
  requirement written on them, e.g. "Ring 5 — grow 3 more planets".
  The header shows "N / M rings used" and the next unlock.
- **Detail:** click a planet → a side panel with large ASCII art,
  name, seed, terrain, ring type, moons, size, stage, characters
  grown, mutations, and generation — plus **Remove from system**
  (moves it to the Archive, never deletes it) and **Replace**.
- **Archive:** scroll down for the grid of ALL owned planets
  (unlimited), searchable and sortable, each card with an
  "In system" badge and the count "N planets — M in system".
  Click an empty ring → the Archive opens in picker mode, filtered
  to planets not already displayed.
- **Orbits:** always on. The planets drift slowly around the star —
  there is no static mode and no toggle (Devon's call, Nov 11). The
  drift pauses momentarily on hover/focus and while the webview is
  hidden, so a moving planet can still be clicked. 2D zoom
  (wheel/buttons, fit-to-system reset) and drag-pan only — no 3D
  rotation (ASCII shears, and rotation hurts click-to-select).
- **Hard rules:** growing a new planet never fails because the system
  is full — the new planet lands in the Archive. Removing a planet
  from the system never deletes it.
- **Planet names:** every planet gets a real catalog-style name tied
  to its seed — `generatePlanetName(seed)` in `planet.js` builds a
  designation like Kepler-442b, TRAPPIST-1e, HD-209458b, or TOI-700d
  (catalog + number + letter b–f) from `NAME_CATALOGS` in `CONFIG`,
  on its own RNG stream (`seed ^ 0x9E3779B9`), so naming never
  disturbs the trait draws. The name is stored on the planet record
  at birth and derived from the seed for older records. A birth-time
  uniqueness layer (`uniquePlanetName` in `petLogic.js`) nudges the
  number/letter deterministically when a name is already used by
  another planet in the collection, so no two planets share a name.
  Shown in the orrery, the detail panel, and the Archive cards.
- **Tests:** `node test-pet.js` — now 509 checks (was 110; sections 13–16
  cover System Rank / slot unlocks, place/remove validation,
  salvage clearing a slot, rank-drop returning the planet to the
  Archive, overflow-to-Archive, persistence, panel wiring, the
  share card below, and seed hatch).
  `node test-planet.js` — 207 checks; section 15 covers name determinism
  (same seed → same name, starter/tilt don't change the name),
  format, and variety. Plus a wiring harness
  (`../scratch/test-system-panel.js`, fake `vscode` module) that
  loads `extension.js` for real, grows 4 finished planets by typing,
  opens the panel, and drives place/remove messages through the
  webview: 33 checks, all passing.

## Share card (DONE Nov 12)

One click, one card. Command **Protoplanet: Share planet** opens a panel
with the live animated planet (same fixed-cell render as the sidebar),
its catalog name, stage, generation, mutation badge when it has one,
and seed — plus three actions:

- **Download PNG** — draws the same planet on a canvas at 8px cells
  (the full 136×76 grid, 1088px wide + an amber `Name · seed <seed>`
  caption) and saves it via a save dialog as
  `protoplanet-<name>-gen<N>.png`. Postable on X/Reddit or in a README.
- **Copy seed** — the seed on the clipboard. A friend can paste it into
  their own Protoplanet and hatch the same base planet, without
  mutations (see Hatch from seed below).
- **Copy Markdown** — a README-ready block (image line, bold name/terrain/
  stage/generation/characters line, mutation line when present, seed line
  linking back to https://github.com/devoncline/protoplanet).

The filename and the Markdown are pure helpers in `petLogic.js`
(`shareCardFilename`, `shareCardMarkdown`) so the panel and the tests
agree on exactly what gets shared. The card stays live while typing
(`pushState` posts fresh state) and re-opening the command reveals the
same panel. No new popups: the save confirmation flashes on the Download
button in the panel, and the only info message is the no-planet guard
("No planet yet — pick a starter first, then share it.").
- **Tests:** `node test-pet.js` — section 15 (filename slug rules,
  markdown shape with/without a mutation, panel wiring). Plus a wiring
  harness (`../scratch/test-share-panel.js`, fake `vscode` module) that
  loads `extension.js` for real, opens the panel, and drives the
  download / copy-seed / copy-markdown messages through the webview:
  36 checks, all passing. The PNG itself was rendered in headless
  Chrome (`../scratch/share-png-probe.html`) and eyeballed: the full
  grid at 8px cells reads as the dense sphere Devon knows — the cozy
  68×38 grid at 16px cells was tried first and looked like a loose
  scatter of letters with a hole for a night side, so it was cut.

## Hatch from seed (DONE Nov 12)

Command: **Protoplanet: Hatch from seed** (`protoplanet.hatchFromSeed`).

Paste a seed number and hatch that seed's planet. Same seed = same
planet: same terrain, rings, moons, size, and catalog name. **But never
the mutations** — a planet hatched from a shared seed is the seed's
base planet, mutations stripped (`stripMutations` in `planet.js`:
mutations cleared, ring back to the base roll, mutation-granted hue /
second tilt / oversized moon reset, summary recomputed). Mutations stay
unique to the original — nobody gets your rare mutated planet just by
pasting its seed.

Flow: input box for the seed (validated: digits only, 0–999999999),
then the same modal confirm as New planet. The current planet is
archived into the collection — mutations and all — and the hatched
planet becomes the new current planet at Gen +1, 0 XP. A fed mineral
is NOT consumed: the hatch is the seed's canonical planet, not a roll,
so the fed mineral stays fed for the next birth that actually rolls.
On a fresh install (no planet yet) the hatch IS the first planet —
starter done + the one free starter mineral, still Gen 1. One honest
limit: a first planet born from a starter pick has its terrain forced
by the pick, not the seed, so hatching from its seed gives the seed's
canonical terrain, which can differ. No new popups: the input box and
confirm are user-invoked from the Command Palette, and the result
shows in the pet window and status bar.
- **Tests:** `node test-planet.js` — section 17 (strip per mutation,
  13/13 clean, stripped renders exactly like the plain twin and
  differently from the mutated original, plain planet untouched,
  determinism). `node test-pet.js` — section 16 (seed parsing,
  makeSeedPlanet, archive-keeps-mutations, fed mineral survives the
  hatch, first-run hatch, same-seed name nudge, package.json +
  extension wiring). Plus a wiring harness
  (`../scratch/test-seed-hatch.js`, fake `vscode` module) that loads
  `extension.js` for real, activates it with a live mutated planet,
  and drives the command end to end (happy path, bad input, dismissed
  box, declined confirm): 13 checks, all passing.

## What's next (pieces 3+, only after Devon approves piece 2)
- **Design polish: DONE Nov 11** — reel-style restyle of the renderer
  (136×76 grid, limb fade, softer light, denser rings). See above.
- **Piece 3 — mutations: DONE Nov 11** — birth rolls, no tiers,
  13 mutations (see `MUTATIONS.md`). Rarity: ~9.0% any mutation.
- **Piece 4 — collection panel: DONE Nov 11** — the Solar System
  view above (tilted orrery, detail panel, Archive, System Rank,
  planet names).
- **Piece 5 — minerals, salvage, prestige: DONE Nov 11** — feed
  minerals to tilt the NEXT planet's birth roll; destroy a planet
  for mineral pieces (a mutation planet yields a mineral of that
  mutation); combine two Civilization-stage planets — offspring
  inherits each parent mutation at multiplied odds, parents stay
  in the collection (one-time parents, tunable flag).
- **Piece 6 — public polish:** Marketplace-ready (icon, README,
  publisher, packaging). Only when Devon says go.

## Rules the build follows

- **Fixed-size cells for ALL HTML rendering — no exceptions.** A grid
  is rendered with `gridToHtml()` (explicit-width inline-block run
  spans, 10:18 cell ratio) + the `.pp-grid` / `.pp-run` CSS + a
  runtime-measured font size so one glyph advance == one cell width +
  `text-size-adjust: none`. NEVER render a grid in a bare `<pre>` with
  a font-size/line-height and trust the font — iOS Safari inflates
  small text while line-height stays fixed and the planet comes out
  squashed ~2:1 wide and flat (found by Devon on his phone, Nov 10;
  fixed in preview.html the same night). The VS Code webview in
  piece 2 MUST reuse `gridToHtml()` and these CSS rules — it has the
  exact same font-variance problem. The cell ratio may scale down on
  narrow screens, but it must stay 10:18.
- **Never crop the planet:** when the window shrinks, re-render the
  same planet at a lower resolution (fewer, bigger characters) — still
  a whole planet made of readable characters. Scaling glyphs down has
  a floor. Full detail lives in the big panel (piece 4). (Devon,
  Nov 11 — cropping ruins the "characters make up the planet" idea.)
- **Ambient, never interrupting:** no popups while typing. Evolutions
  show in the pet window and status bar only. The full panel opens
  only when Devon opens it.
- **Local only until Devon says otherwise:** no Marketplace
  publishing, no network calls, no AI generation.
- **Devon reviews before anything goes live.**
