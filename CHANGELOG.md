# Changelog

## Unreleased

- Round 28: share a planet as an animated GIF (72 frames, ring-fit
  crop, name/seed/stage captioned on it) plus a ready-to-post caption
  with the seed and a Marketplace link. The PNG download and the
  Markdown block are gone.
- Round 28 follow-up: the share preview shows the same framing as the
  GIF (what you see is what you download); the mutation pill is the
  violet name-only pill; the caption and the panel meta read
  "Stage 7 of 7" with the Stardust earn rate; the seed is a labeled
  field instead of a bare dark square.

## 0.1.0 — First release

- A planet that grows as you type: 1 character = 1 XP, through seven
  stages from Shattered birth to Civilization. No forced rebirth.
- 13 rare birth mutations (about 1 in 10 planets), plus mutation sets
  like Moon Lord and Ring King.
- Stardust earned per character typed — never passive. Spend it in the
  shop on Birth Minerals (2,500 ✦), Random Mutation Minerals
  (250,000 ✦), and Family Mutation Minerals (400,000 ✦).
- Salvage planets for minerals; prestige two Civilization planets into
  a child that inherits their mutations.
- Solar system view: a tilted orrery around a star, plus an Index of
  your whole collection. Finishing more planets unlocks more rings.
- Share a planet by seed, PNG, or Markdown. Hatch a shared seed to get
  the same base planet (without its mutations).
- Sidebar pet view, status bar with stage and XP, and a discovery
  journal that records your planet's story.
- Renamed from Protoplanet to Terrabyte — new extension name
  (`devoncline.terrabyte`), new commands, same game. Note: VS Code
  stores saves per extension ID, so a save made under Protoplanet
  does not automatically appear under Terrabyte — copy
  `state.vscdb` from the old extension's globalStorage folder to
  the new one to bring it over.
