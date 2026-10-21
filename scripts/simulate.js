#!/usr/bin/env node
/*
 * Headless level balancing simulator.
 * Plays many games per level with a random bot and a greedy bot, then reports
 * win rate, average score and star distribution so targets can be tuned.
 *
 * Usage: node scripts/simulate.js [gamesPerLevel]
 */
const { Game, LEVELS } = require('../src/core.js');

const GAMES = Number(process.argv[2]) || 200;

function pickRandom(game) {
  const swaps = game.board.allValidSwaps();
  return swaps[Math.floor(game.rng() * swaps.length)];
}

// Greedy one-step lookahead: simulate every legal swap on a copy, keep the best scoring one.
function pickGreedy(game) {
  let best = null;
  let bestPoints = -1;
  for (const [a, b] of game.board.allValidSwaps()) {
    const copy = game.board.clone();
    const result = copy.playSwap(a, b);
    const points = result.steps.reduce((s, step) => s + step.points, 0);
    if (points > bestPoints) {
      bestPoints = points;
      best = [a, b];
    }
  }
  return best;
}

function run(levelIndex, strategy, seedBase) {
  const stats = { wins: 0, score: 0, stars: [0, 0, 0, 0], cascade: 0 };
  for (let i = 0; i < GAMES; i++) {
    const game = new Game(levelIndex, seedBase + i);
    while (!game.over) {
      const [a, b] = strategy(game);
      game.move(a, b);
    }
    stats.wins += game.won ? 1 : 0;
    stats.score += game.score;
    stats.stars[game.stars]++;
    stats.cascade = Math.max(stats.cascade, game.bestCascade);
  }
  return stats;
}

const pct = (n) => ((100 * n) / GAMES).toFixed(1).padStart(5) + '%';

console.log(`Simulating ${GAMES} games per level and strategy\n`);
console.log('Level    Bot     Target  Win rate  Avg score  0/1/2/3 stars        Max cascade');
LEVELS.forEach((level, i) => {
  for (const [name, fn] of [['random', pickRandom], ['greedy', pickGreedy]]) {
    const t0 = Date.now();
    const s = run(i, fn, 1000 * (i + 1));
    console.log(
      `${level.name.padEnd(8)} ${name.padEnd(7)} ${String(level.target).padStart(6)}  ${pct(s.wins)}  ` +
        `${String(Math.round(s.score / GAMES)).padStart(9)}  ${s.stars.map(pct).join(' ')}  ${s.cascade}` +
        `   (${Date.now() - t0} ms)`
    );
  }
});
