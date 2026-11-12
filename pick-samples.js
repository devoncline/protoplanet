// pick-samples.js — scan seeds and pick a diverse showcase set:
// one planet per terrain, preferring ones with rings and moons so the
// preview shows the variety. Writes the seed list as JSON to stdout.
'use strict';
const P = require('./planet.js');

const picks = {}; // terrain -> { seed, score, planet }
for (let seed = 1; seed <= 3000; seed++) {
  const p = P.generatePlanet(seed);
  // Score: rings and moons make a planet more interesting to look at.
  let score = 0;
  if (p.ringType !== 'none') score += 3;
  if (p.ringType === 'double' || p.ringType === 'colored' || p.ringType === 'shattered') score += 2;
  score += p.moons.length;
  if (p.size > 0.95 && p.size < 1.1) score += 1;
  if (!picks[p.terrain] || score > picks[p.terrain].score) {
    picks[p.terrain] = { seed, score, planet: p };
  }
}
const list = Object.values(picks)
  .sort((a, b) => a.planet.terrain.localeCompare(b.planet.terrain))
  .map(({ seed, planet }) => ({ seed, terrain: planet.terrain, summary: planet.summary }));
console.log(JSON.stringify(list, null, 2));
