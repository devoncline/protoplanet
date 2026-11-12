// dump-samples.js — render the showcase planets to JSON grids so
// make-samples.py can draw them as PNG stills.
// Usage: node dump-samples.js < seeds.json > samples.json
'use strict';
const fs = require('fs');
const P = require('./planet.js');

const seeds = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const { seed } of seeds) {
  const planet = P.generatePlanet(seed);
  // Base samples are the plain stage/terrain reference — strip any
  // mutation the seed rolled (mutations have their own stills). The
  // hero seed 1838 rolls big-moon under the birth model; without this
  // its lifecycle stills would show a big moon the titles never name.
  planet.mutations = [];
  // Civilization stage (rings open, most impressive) + Oceans for contrast.
  for (const [stage, t, sec, tag] of [[6, 5.0, 3.0, 'civ'], [4, 5.0, 3.0, 'oceans']]) {
    out.push({
      seed, tag, stage: P.STAGES[stage].name,
      summary: planet.summary, terrain: planet.terrain,
      grid: P.render(planet, stage, t, sec),
    });
  }
}
// One planet across all 8 stages, to show the lifecycle.
const hero = P.generatePlanet(seeds[0].seed);
hero.mutations = []; // plain, like the rest of the base set (see above).
for (let i = 0; i < 8; i++) {
  out.push({
    seed: hero.seed, tag: `stage${i + 1}`, stage: P.STAGES[i].name,
    summary: hero.summary, terrain: hero.terrain,
    grid: P.render(hero, i, P.STAGES[i].dur * 0.5, 2.0 + i),
  });
}
console.log(JSON.stringify(out));
