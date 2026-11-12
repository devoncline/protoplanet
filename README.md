# Protoplanet — a VS Code extension (in progress)

A coding pet for VS Code: as you type, a little ASCII planet grows —
through an 8-stage lifecycle (dust → rock →
world → civilization → end → rebirth). Typing is the fuel: the planet
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
  8 stages, and a "Roll a new planet" button for a fresh random seed.
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
  on startup. Contributes a sidebar view (own activity-bar icon,
  hand-drawn `media/planet.svg`), plus commands **Protoplanet: Show pet**
  and **Protoplanet: New planet** (asks first; the old planet is kept in
  the collection record). A "New planet" button also sits in the view's
  title bar.
- **`petLogic.js`** — the pure logic, no `vscode` import, tested in plain
  Node (`node test-pet.js`, 110 checks). Typing = XP (1 inserted char =
  1 XP; deletions earn nothing; undo/redo and non-text documents like
  the output panel earn nothing). XP grows the planet through the 8
  stages — thresholds `0 / 100 / 300 / 600 / 1000 / 1500 / 2200 / 3000`,
  then rebirth at 3600 XP (old planet archived, new seed, generation +1,
  leftover XP carries over — a giant paste can even rebirth twice).
  First run asks for a starter terrain (icy / lava / jungle / rocky /
  ocean), which biases the first planet's seed. All numbers live in one
  `CONFIG` object at the top of `petLogic.js`.
- **`extension.js`** — VS Code wiring only: sidebar webview, status bar
  (globe icon + `Oceans · 640/1000 XP`, click to show the pet), `globalState`
  persistence (one key, debounced 3s while typing, immediate on stage
  change / rebirth / new planet). **Ambient:** no popups while typing —
  evolutions show in the pet window and status bar only.
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
- **Tests:** `node test-pet.js` — 110 checks (XP counting, stage
  boundaries, rebirth incl. double rebirth, starter bias, new-planet
  command, persistence round-trip, bad-data fallback, package.json
  contract). Plus a wiring harness (`/tmp/test-extension-wiring.js`,
  fake `vscode` module) that loads `extension.js` for real and drives
  activation, typing events, status bar, webview messages and the
  generated HTML: 30 checks, all passing.
- **Not verified here:** the Extension Development Host can't run
  headless on this VM — Devon runs it with F5 on his PC. That's the
  real test.

## What's next (pieces 3+, only after Devon approves piece 2)
- **Design polish: DONE Nov 11** — reel-style restyle of the renderer
  (136×76 grid, limb fade, softer light, denser rings). See above.
- **Piece 3 — mutations:** the rarity system — inheritable traits
  (big moon, colored/double/shattered rings, aurora, sparkling
  surface, glowing oceans, giant storm, comet, binary star, city
  lights) rolled on each evolution, with weighted odds. Tiers
  (Common→Legendary) are just labels derived from mutations.
- **Piece 4 — collection panel:** a webview showing all finished
  planets as a little solar system; click one to see its seed, traits,
  mutations, characters grown, generation.
- **Piece 5 — minerals, salvage, prestige:** feed minerals to tilt
  mutation odds; destroy a planet for mineral pieces (a mutation
  planet yields a mineral of that mutation); combine two
  Civilization-stage planets — offspring inherits each parent
  mutation at multiplied odds, parents stay in the collection.
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
