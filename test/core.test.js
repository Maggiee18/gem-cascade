const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, Game, SPECIAL, RAINBOW_TYPE, mulberry32 } = require('../src/core.js');

// Letters make test boards easier to read: A=0, B=1, C=2, D=3, E=4.
const parse = (rows) => rows.map((s) => [...s].map((ch) => ch.charCodeAt(0) - 65));

test('a new board starts with no matches and at least one legal move', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const b = new Board(8, 8, 6, mulberry32(seed));
    assert.equal(b.findMatches().length, 0);
    assert.ok(b.findHint());
  }
});

test('finds horizontal and vertical runs of three', () => {
  const b = Board.fromTypes(parse(['AAAB', 'BCDC', 'BDCD', 'BCDE']), 5);
  const groups = b.findMatches();
  assert.equal(groups.length, 2);
  const sizes = groups.map((g) => g.cells.length).sort();
  assert.deepEqual(sizes, [3, 3]);
});

test('merges an L shape into one group and creates a bomb at the corner', () => {
  const b = Board.fromTypes(parse(['ABCD', 'ACDB', 'AAAC', 'BDBD']), 5);
  const groups = b.findMatches();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cells.length, 5);
  const s = Board.specialFor(groups[0], []);
  assert.equal(s.special, SPECIAL.BOMB);
  assert.deepEqual(s.at, [2, 0]);
});

test('merges a T shape into one group and creates a bomb at the junction', () => {
  const b = Board.fromTypes(parse(['AAAB', 'BACD', 'CADB']), 5);
  const groups = b.findMatches();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cells.length, 5);
  const s = Board.specialFor(groups[0], []);
  assert.equal(s.special, SPECIAL.BOMB);
  assert.deepEqual(s.at, [0, 1]);
});

test('four in a row makes a line gem, five makes a rainbow gem', () => {
  const four = Board.fromTypes(parse(['AAAAB', 'BCDEC', 'CDECD']), 5).findMatches()[0];
  assert.equal(Board.specialFor(four, []).special, SPECIAL.LINE_V);
  const five = Board.fromTypes(parse(['AAAAA', 'BCDEC', 'CDECD']), 5).findMatches()[0];
  assert.equal(Board.specialFor(five, []).special, SPECIAL.RAINBOW);
});

test('rejects swaps that are not adjacent or create no match', () => {
  const b = Board.fromTypes(parse(['ABAB', 'BABA', 'ABAB', 'BABA']), 5);
  assert.equal(b.isValidSwap([0, 0], [0, 2]), false);
  assert.equal(b.isValidSwap([0, 0], [2, 0]), false);
  assert.equal(b.playSwap([0, 0], [1, 1]), null);
});

test('a legal swap clears gems, applies gravity and keeps the board full', () => {
  const b = Board.fromTypes(parse(['BCDE', 'CDEB', 'AABA', 'DEDC']), 5, mulberry32(7));
  const result = b.playSwap([2, 2], [2, 3]);
  assert.ok(result);
  assert.ok(result.steps.length >= 1);
  assert.equal(result.steps[0].clearedIds.length, 3);
  for (const row of b.grid) for (const t of row) assert.ok(t);
  assert.equal(b.findMatches().length, 0, 'cascades resolve until stable');
});

test('gravity drops surviving gems straight down', () => {
  const b = Board.fromTypes(parse(['BC', 'DE', 'AA']), 5, mulberry32(3));
  const topId = b.grid[0][0].id;
  b.grid[2][0] = null;
  b.grid[1][0] = null;
  b.applyGravity();
  assert.equal(b.grid[2][0].id, topId);
});

test('line gem clears its whole row when matched', () => {
  const b = Board.fromTypes(parse(['BCDEB', 'AAACD', 'CDEBC']), 5, mulberry32(9));
  b.grid[1][4].special = SPECIAL.LINE_H;
  const cleared = b.expandBlasts([5, 6, 7]); // row 1, cols 0..2
  assert.equal(cleared.size, 3); // the line gem is not in the match yet
  const withLine = b.expandBlasts([5, 6, 7, 9]);
  assert.equal(withLine.size, 5); // whole row 1
});

test('swapping a rainbow gem clears every gem of that color', () => {
  const b = Board.fromTypes(parse(['ABCB', 'BCAD', 'CADC', 'DCBA']), 5, mulberry32(11));
  b.grid[0][0].special = SPECIAL.RAINBOW;
  b.grid[0][0].type = RAINBOW_TYPE;
  const bCount = b.cellsOfType(1).length;
  const result = b.playSwap([0, 0], [0, 1]);
  assert.ok(result);
  assert.ok(result.steps[0].clearedIds.length >= bCount + 1);
});

test('shuffle produces a playable board with no matches', () => {
  const b = new Board(6, 6, 5, mulberry32(5));
  b.shuffle();
  assert.equal(b.findMatches().length, 0);
  assert.ok(b.findHint());
});

test('a game spends one move per legal swap and tracks score and stars', () => {
  const g = new Game(0, 42);
  const [a, c] = g.board.findHint();
  const before = g.movesLeft;
  assert.ok(g.move(a, c));
  assert.equal(g.movesLeft, before - 1);
  assert.ok(g.score > 0);
  assert.equal(g.stars, g.score >= g.level.target ? g.stars : 0);
});
