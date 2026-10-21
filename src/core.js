/*
 * Gem Cascade core engine.
 * Pure game logic with no DOM access, so it runs in the browser, in Node tests,
 * and in the headless level simulator.
 */
(function (root) {
  'use strict';

  const SPECIAL = Object.freeze({
    NONE: 0,
    LINE_H: 1, // clears its whole row
    LINE_V: 2, // clears its whole column
    BOMB: 3,   // clears the 3x3 area around it
    RAINBOW: 4,  // clears every gem of one color
  });

  const RAINBOW_TYPE = -1; // rainbow gems have no color of their own

  // Small, fast, seedable PRNG so games and tests are reproducible.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Board {
    constructor(rows, cols, numTypes, rng) {
      this.rows = rows;
      this.cols = cols;
      this.numTypes = numTypes;
      this.rng = rng || Math.random;
      this.nextId = 1;
      this.grid = [];
      this.fillInitial();
    }

    /* ---------- creation ---------- */

    newTile(type, special) {
      return { id: this.nextId++, type, special: special || SPECIAL.NONE };
    }

    randomType() {
      return Math.floor(this.rng() * this.numTypes);
    }

    // Fill the grid so that no match exists at the start and at least one move is possible.
    fillInitial() {
      do {
        this.grid = [];
        for (let r = 0; r < this.rows; r++) {
          const row = [];
          for (let c = 0; c < this.cols; c++) {
            let type;
            do {
              type = this.randomType();
            } while (
              (c >= 2 && row[c - 1].type === type && row[c - 2].type === type) ||
              (r >= 2 && this.grid[r - 1][c].type === type && this.grid[r - 2][c].type === type)
            );
            row.push(this.newTile(type));
          }
          this.grid.push(row);
        }
      } while (!this.findHint());
    }

    static fromTypes(types, numTypes, rng) {
      // Build a board from a 2D array of type numbers (used by tests).
      const b = Object.create(Board.prototype);
      b.rows = types.length;
      b.cols = types[0].length;
      b.numTypes = numTypes;
      b.rng = rng || mulberry32(1);
      b.nextId = 1;
      b.grid = types.map((row) => row.map((t) => b.newTile(t)));
      return b;
    }

    clone() {
      const b = Object.create(Board.prototype);
      b.rows = this.rows;
      b.cols = this.cols;
      b.numTypes = this.numTypes;
      b.rng = this.rng;
      b.nextId = this.nextId;
      b.grid = this.grid.map((row) => row.map((t) => (t ? { ...t } : null)));
      return b;
    }

    get(r, c) {
      return this.inBounds(r, c) ? this.grid[r][c] : null;
    }

    inBounds(r, c) {
      return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
    }

    typesSnapshot() {
      return this.grid.map((row) => row.map((t) => (t ? t.type : null)));
    }

    /* ---------- match detection ---------- */

    // Returns match groups. Runs that share a cell are merged (union-find),
    // which is how L and T shapes are recognised.
    findMatches() {
      const runs = [];
      const sameType = (a, b) => a && b && a.type !== RAINBOW_TYPE && a.type === b.type;

      for (let r = 0; r < this.rows; r++) {
        let start = 0;
        for (let c = 1; c <= this.cols; c++) {
          if (c < this.cols && sameType(this.grid[r][c], this.grid[r][start])) continue;
          if (c - start >= 3) {
            const cells = [];
            for (let k = start; k < c; k++) cells.push([r, k]);
            runs.push({ dir: 'h', cells });
          }
          start = c;
        }
      }
      for (let c = 0; c < this.cols; c++) {
        let start = 0;
        for (let r = 1; r <= this.rows; r++) {
          if (r < this.rows && sameType(this.grid[r][c], this.grid[start][c])) continue;
          if (r - start >= 3) {
            const cells = [];
            for (let k = start; k < r; k++) cells.push([k, c]);
            runs.push({ dir: 'v', cells });
          }
          start = r;
        }
      }

      // Union-find over runs that share at least one cell.
      const parent = runs.map((_, i) => i);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      const owner = new Map();
      runs.forEach((run, i) => {
        for (const [r, c] of run.cells) {
          const key = r * this.cols + c;
          if (owner.has(key)) parent[find(i)] = find(owner.get(key));
          else owner.set(key, i);
        }
      });

      const groups = new Map();
      runs.forEach((run, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, { runs: [], cells: new Map() });
        const g = groups.get(root);
        g.runs.push(run);
        for (const [r, c] of run.cells) g.cells.set(r * this.cols + c, [r, c]);
      });

      return [...groups.values()].map((g) => ({
        runs: g.runs,
        cells: [...g.cells.values()],
        type: this.grid[g.runs[0].cells[0][0]][g.runs[0].cells[0][1]].type,
      }));
    }

    // Decide which special gem (if any) a match group creates, and where.
    static specialFor(group, preferred) {
      const longest = group.runs.reduce((m, run) => Math.max(m, run.cells.length), 0);
      const hasH = group.runs.some((run) => run.dir === 'h');
      const hasV = group.runs.some((run) => run.dir === 'v');
      let special = SPECIAL.NONE;
      if (longest >= 5) special = SPECIAL.RAINBOW;
      else if (hasH && hasV) special = SPECIAL.BOMB;
      else if (longest === 4) special = group.runs[0].dir === 'h' ? SPECIAL.LINE_V : SPECIAL.LINE_H;
      if (special === SPECIAL.NONE) return null;

      const inGroup = (pos) => pos && group.cells.some(([r, c]) => r === pos[0] && c === pos[1]);
      let at = (preferred || []).find(inGroup);
      if (!at && hasH && hasV) {
        // Intersection of an L or T shape.
        const counts = new Map();
        for (const run of group.runs) {
          for (const [r, c] of run.cells) {
            const k = r + ',' + c;
            counts.set(k, (counts.get(k) || 0) + 1);
          }
        }
        for (const [k, n] of counts) if (n > 1) at = k.split(',').map(Number);
      }
      if (!at) {
        const run = group.runs.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
        at = run.cells[Math.floor(run.cells.length / 2)];
      }
      return { special, at };
    }

    /* ---------- special effects ---------- */

    // Cells hit by triggering the special gem at (r, c).
    blastArea(r, c, tile) {
      const cells = [];
      if (tile.special === SPECIAL.LINE_H) {
        for (let k = 0; k < this.cols; k++) cells.push([r, k]);
      } else if (tile.special === SPECIAL.LINE_V) {
        for (let k = 0; k < this.rows; k++) cells.push([k, c]);
      } else if (tile.special === SPECIAL.BOMB) {
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) if (this.inBounds(r + dr, c + dc)) cells.push([r + dr, c + dc]);
      } else if (tile.special === SPECIAL.RAINBOW) {
        const target = this.mostCommonType();
        cells.push([r, c], ...this.cellsOfType(target));
      }
      return cells;
    }

    cellsOfType(type) {
      const cells = [];
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) if (this.grid[r][c] && this.grid[r][c].type === type) cells.push([r, c]);
      return cells;
    }

    mostCommonType() {
      const counts = new Array(this.numTypes).fill(0);
      for (const row of this.grid) for (const t of row) if (t && t.type >= 0) counts[t.type]++;
      return counts.indexOf(Math.max(...counts));
    }

    // Breadth-first expansion: any special gem inside the cleared area fires too (chain reactions).
    expandBlasts(initialKeys) {
      const cleared = new Set(initialKeys);
      const queue = [...initialKeys];
      const fired = new Set();
      while (queue.length) {
        const key = queue.shift();
        const r = Math.floor(key / this.cols);
        const c = key % this.cols;
        const tile = this.grid[r][c];
        if (!tile || tile.special === SPECIAL.NONE || fired.has(key)) continue;
        fired.add(key);
        for (const [br, bc] of this.blastArea(r, c, tile)) {
          const k = br * this.cols + bc;
          if (!cleared.has(k)) {
            cleared.add(k);
            queue.push(k);
          }
        }
      }
      return cleared;
    }

    /* ---------- moves ---------- */

    static isAdjacent(a, b) {
      return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
    }

    swapCells(a, b) {
      const t = this.grid[a[0]][a[1]];
      this.grid[a[0]][a[1]] = this.grid[b[0]][b[1]];
      this.grid[b[0]][b[1]] = t;
    }

    isColorSwap(a, b) {
      return this.get(a[0], a[1]).special === SPECIAL.RAINBOW || this.get(b[0], b[1]).special === SPECIAL.RAINBOW;
    }

    // A swap is legal if the gems are adjacent and it creates a match or involves a rainbow gem.
    isValidSwap(a, b) {
      if (!this.inBounds(a[0], a[1]) || !this.inBounds(b[0], b[1]) || !Board.isAdjacent(a, b)) return false;
      if (this.isColorSwap(a, b)) return true;
      this.swapCells(a, b);
      const ok = this.findMatches().length > 0;
      this.swapCells(a, b);
      return ok;
    }

    // Brute force over every adjacent pair: O(rows * cols) swaps, each with an O(rows * cols) scan.
    findHint() {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (c + 1 < this.cols && this.isValidSwap([r, c], [r, c + 1])) return [[r, c], [r, c + 1]];
          if (r + 1 < this.rows && this.isValidSwap([r, c], [r + 1, c])) return [[r, c], [r + 1, c]];
        }
      }
      return null;
    }

    allValidSwaps() {
      const swaps = [];
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (c + 1 < this.cols && this.isValidSwap([r, c], [r, c + 1])) swaps.push([[r, c], [r, c + 1]]);
          if (r + 1 < this.rows && this.isValidSwap([r, c], [r + 1, c])) swaps.push([[r, c], [r + 1, c]]);
        }
      }
      return swaps;
    }

    /* ---------- resolution ---------- */

    // Collapse each column downward, then refill from the top.
    // Returns the ids of newly spawned tiles with how far above the board they start.
    applyGravity() {
      const spawned = [];
      for (let c = 0; c < this.cols; c++) {
        let write = this.rows - 1;
        for (let r = this.rows - 1; r >= 0; r--) {
          if (this.grid[r][c]) {
            const t = this.grid[r][c];
            this.grid[r][c] = null;
            this.grid[write][c] = t;
            write--;
          }
        }
        const missing = write + 1;
        for (let r = write; r >= 0; r--) {
          const t = this.newTile(this.randomType());
          this.grid[r][c] = t;
          spawned.push({ id: t.id, row: r, col: c, from: r - missing });
        }
      }
      return spawned;
    }

    // Performs a swap and resolves every cascade.
    // Returns animation-ready steps, or null when the swap is illegal.
    playSwap(a, b) {
      if (!this.isValidSwap(a, b)) return null;
      this.swapCells(a, b);
      const steps = [];
      let cascade = 0;

      if (this.isColorSwap(a, b)) {
        const ta = this.get(a[0], a[1]);
        const tb = this.get(b[0], b[1]);
        let keys;
        if (ta.special === SPECIAL.RAINBOW && tb.special === SPECIAL.RAINBOW) {
          keys = [];
          for (let k = 0; k < this.rows * this.cols; k++) keys.push(k);
        } else {
          const rainbowPos = ta.special === SPECIAL.RAINBOW ? a : b;
          const other = ta.special === SPECIAL.RAINBOW ? tb : ta;
          keys = [rainbowPos, ...this.cellsOfType(other.type)].map(([r, c]) => r * this.cols + c);
        }
        // Mark the rainbow gem as spent so it doesn't fire a second time.
        const rainbow = ta.special === SPECIAL.RAINBOW ? ta : tb;
        rainbow.special = SPECIAL.NONE;
        steps.push(this.clearAndCollapse(this.expandBlasts(keys), [], ++cascade));
      }

      let preferred = [b, a];
      for (;;) {
        const groups = this.findMatches();
        if (!groups.length) break;
        const creations = groups.map((g) => Board.specialFor(g, preferred)).filter(Boolean);
        const keys = [];
        for (const g of groups) for (const [r, c] of g.cells) keys.push(r * this.cols + c);
        steps.push(this.clearAndCollapse(this.expandBlasts(keys), creations, ++cascade, groups));
        preferred = [];
      }

      let shuffled = false;
      if (!this.findHint()) {
        this.shuffle();
        shuffled = true;
      }
      return { steps, shuffled };
    }

    clearAndCollapse(clearedKeys, creations, cascade, groups) {
      const created = [];
      const keep = new Set();
      for (const { special, at } of creations) {
        const k = at[0] * this.cols + at[1];
        const tile = this.grid[at[0]][at[1]];
        if (!tile || keep.has(k)) continue;
        keep.add(k);
        tile.special = special;
        if (special === SPECIAL.RAINBOW) tile.type = RAINBOW_TYPE;
        created.push({ id: tile.id, special, row: at[0], col: at[1] });
      }

      const clearedIds = [];
      for (const k of clearedKeys) {
        if (keep.has(k)) continue;
        const r = Math.floor(k / this.cols);
        const c = k % this.cols;
        if (this.grid[r][c]) {
          clearedIds.push(this.grid[r][c].id);
          this.grid[r][c] = null;
        }
      }

      const points = clearedIds.length * 10 * cascade + created.length * 50;
      const spawned = this.applyGravity();
      return {
        cascade,
        clearedIds,
        created,
        spawned,
        points,
        matchCount: groups ? groups.length : 0,
        positions: this.positions(),
      };
    }

    // id -> [row, col] for every tile, used by the UI to animate.
    positions() {
      const map = {};
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) {
          const t = this.grid[r][c];
          map[t.id] = { row: r, col: c, type: t.type, special: t.special };
        }
      return map;
    }

    // Fisher-Yates shuffle until the board has no matches and at least one move.
    shuffle() {
      const tiles = this.grid.flat();
      for (let attempt = 0; attempt < 100; attempt++) {
        for (let i = tiles.length - 1; i > 0; i--) {
          const j = Math.floor(this.rng() * (i + 1));
          [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
        }
        for (let r = 0; r < this.rows; r++)
          for (let c = 0; c < this.cols; c++) this.grid[r][c] = tiles[r * this.cols + c];
        if (!this.findMatches().length && this.findHint()) return;
      }
      this.fillInitial();
    }
  }

  /* ---------- game session (levels, moves, score, stars) ---------- */

  const LEVELS = [
    // Targets tuned with scripts/simulate.js (see README for the results table).
    { name: 'Level 1', rows: 8, cols: 8, types: 5, moves: 20, target: 3000 },
    { name: 'Level 2', rows: 8, cols: 8, types: 6, moves: 24, target: 3000 },
    { name: 'Level 3', rows: 9, cols: 9, types: 6, moves: 24, target: 4500 },
  ];

  class Game {
    constructor(levelIndex, seed) {
      this.levelIndex = levelIndex || 0;
      this.level = LEVELS[this.levelIndex];
      this.rng = mulberry32(seed == null ? Date.now() : seed);
      this.board = new Board(this.level.rows, this.level.cols, this.level.types, this.rng);
      this.score = 0;
      this.movesLeft = this.level.moves;
      this.bestCascade = 0;
    }

    get stars() {
      const t = this.level.target;
      if (this.score >= t * 2) return 3;
      if (this.score >= t * 1.5) return 2;
      if (this.score >= t) return 1;
      return 0;
    }

    get over() {
      return this.movesLeft <= 0;
    }

    get won() {
      return this.score >= this.level.target;
    }

    move(a, b) {
      if (this.over) return null;
      const result = this.board.playSwap(a, b);
      if (!result) return null;
      this.movesLeft--;
      for (const step of result.steps) {
        this.score += step.points;
        this.bestCascade = Math.max(this.bestCascade, step.cascade);
      }
      return result;
    }
  }

  const api = { SPECIAL, RAINBOW_TYPE, LEVELS, Board, Game, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GemCascade = api;
})(typeof window !== 'undefined' ? window : globalThis);
