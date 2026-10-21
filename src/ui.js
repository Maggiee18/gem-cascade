/*
 * Gem Cascade browser UI.
 * Renders the board as absolutely positioned DOM tiles and animates the
 * steps returned by the core engine (swap, clear, create specials, fall).
 */
(function () {
  'use strict';

  const { Game, LEVELS, SPECIAL } = window.GemCascade;

  const T = { swap: 170, clear: 220, fall: 300, pause: 60 };
  const COMBO_WORDS = ['', '', 'Nice!', 'Great!', 'Amazing!', 'Spectacular!'];

  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const els = {
    score: $('score'),
    target: $('target'),
    moves: $('moves'),
    movesStat: $('movesStat'),
    progress: $('progress'),
    levelName: $('levelName'),
    overlay: $('overlay'),
    modalTitle: $('modalTitle'),
    modalStars: $('modalStars'),
    modalText: $('modalText'),
    nextBtn: $('nextBtn'),
    retryBtn: $('retryBtn'),
  };

  let game;
  let levelIndex = 0;
  let busy = false;
  let selected = null;
  let cell = 52;
  let hintTimer = null;
  let soundOn = true;
  const tiles = new Map(); // tile id -> element

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  /* ---------- sound (tiny WebAudio blips, no assets needed) ---------- */

  let audio = null;
  function beep(freq, duration, type) {
    if (!soundOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duration);
    } catch (e) {
      soundOn = false;
    }
  }

  /* ---------- layout ---------- */

  function computeCellSize() {
    const maxBoard = Math.min(window.innerWidth - 48, 500);
    cell = Math.floor(Math.min(56, maxBoard / game.board.cols));
    document.documentElement.style.setProperty('--cell', cell + 'px');
    boardEl.style.width = cell * game.board.cols + 'px';
    boardEl.style.height = cell * game.board.rows + 'px';
  }

  function place(el, row, col) {
    el.style.transform = `translate(${col * cell}px, ${row * cell}px)`;
  }

  function decorate(el, info) {
    el.className = 'tile';
    el.firstChild.className = 'gem' + (info.type >= 0 ? ' t' + info.type : '');
    if (info.special === SPECIAL.LINE_H) el.classList.add('line-h');
    if (info.special === SPECIAL.LINE_V) el.classList.add('line-v');
    if (info.special === SPECIAL.BOMB) el.classList.add('bomb');
    if (info.special === SPECIAL.RAINBOW) el.classList.add('rainbow');
  }

  function makeTile(id, info) {
    const el = document.createElement('div');
    el.appendChild(document.createElement('div'));
    el.dataset.id = id;
    decorate(el, info);
    boardEl.appendChild(el);
    tiles.set(Number(id), el);
    return el;
  }

  function renderAll() {
    boardEl.innerHTML = '';
    tiles.clear();
    computeCellSize();
    for (let r = 0; r < game.board.rows; r++) {
      for (let c = 0; c < game.board.cols; c++) {
        const bg = document.createElement('div');
        bg.className = 'cell-bg';
        bg.style.transform = `translate(${c * cell}px, ${r * cell}px) scale(0.94)`;
        boardEl.appendChild(bg);
      }
    }
    const pos = game.board.positions();
    for (const id in pos) {
      const el = makeTile(id, pos[id]);
      el.classList.add('no-anim');
      place(el, pos[id].row, pos[id].col);
    }
    requestAnimationFrame(() => tiles.forEach((el) => el.classList.remove('no-anim')));
  }

  function updateHud() {
    const { score, movesLeft, level } = game;
    els.score.textContent = score.toLocaleString();
    els.target.textContent = level.target.toLocaleString();
    els.moves.textContent = movesLeft;
    els.movesStat.classList.toggle('low', movesLeft <= 5);
    els.levelName.textContent = level.name;
    // Bar is full at 2x target (3 stars); ticks mark 1.5x (2 stars) and 1x via the 50% mark.
    els.progress.style.width = Math.min(100, (score / (level.target * 2)) * 100) + '%';
  }

  /* ---------- feedback ---------- */

  function floater(text, row, col, combo) {
    const el = document.createElement('div');
    el.className = 'floater' + (combo ? ' combo' : '');
    el.textContent = text;
    el.style.left = (col + 0.5) * cell + 'px';
    el.style.top = row * cell + 'px';
    boardEl.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  async function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    boardEl.appendChild(el);
    await sleep(900);
    el.remove();
  }

  function clearHint() {
    clearTimeout(hintTimer);
    tiles.forEach((el) => el.classList.remove('hint'));
  }

  function showHint() {
    clearHint();
    const hint = game.board.findHint();
    if (!hint) return;
    for (const [r, c] of hint) tiles.get(game.board.grid[r][c].id).classList.add('hint');
  }

  function scheduleHint() {
    clearHint();
    hintTimer = setTimeout(() => !busy && !game.over && showHint(), 7000);
  }

  /* ---------- turn animation ---------- */

  function tileAt(pos) {
    return tiles.get(game.board.grid[pos[0]][pos[1]].id);
  }

  async function animateSwap(a, b, elA, elB) {
    place(elA, b[0], b[1]);
    place(elB, a[0], a[1]);
    await sleep(T.swap);
  }

  async function playStep(step) {
    // 1. Clear matched and blasted gems.
    for (const id of step.clearedIds) {
      const el = tiles.get(id);
      if (el) el.classList.add('clearing');
    }
    beep(400 + step.cascade * 120, 0.12, 'triangle');
    await sleep(T.clear);
    for (const id of step.clearedIds) {
      const el = tiles.get(id);
      if (el) el.remove();
      tiles.delete(id);
    }

    // 2. Upgrade gems that became specials.
    for (const c of step.created) {
      const el = tiles.get(c.id);
      if (!el) continue;
      decorate(el, step.positions[c.id]);
      el.classList.add('pop');
      beep(880, 0.2, 'square');
    }

    // 3. Spawn new gems above the board, then let everything fall.
    for (const s of step.spawned) {
      const el = makeTile(s.id, step.positions[s.id]);
      el.classList.add('no-anim');
      place(el, s.from, s.col);
    }
    await nextFrame();
    for (const [id, el] of tiles) {
      const p = step.positions[id];
      if (!p) continue;
      el.classList.remove('no-anim');
      el.classList.add('falling');
      place(el, p.row, p.col);
    }

    const mid = Math.floor(game.board.cols / 2);
    floater('+' + step.points, 3, mid, false);
    if (step.cascade >= 2) floater(COMBO_WORDS[Math.min(step.cascade, 5)], 1.5, mid, true);
    updateHudPartial(step.points);

    await sleep(T.fall);
    tiles.forEach((el) => el.classList.remove('falling', 'pop'));
    await sleep(T.pause);
  }

  let shownScore = 0;
  function updateHudPartial(points) {
    shownScore += points;
    els.score.textContent = shownScore.toLocaleString();
    els.progress.style.width = Math.min(100, (shownScore / (game.level.target * 2)) * 100) + '%';
  }

  async function trySwap(a, b) {
    if (busy || game.over) return;
    busy = true;
    clearHint();
    deselect();
    const elA = tileAt(a);
    const elB = tileAt(b);

    if (!game.board.isValidSwap(a, b)) {
      beep(160, 0.15, 'sawtooth');
      await animateSwap(a, b, elA, elB);
      place(elA, a[0], a[1]);
      place(elB, b[0], b[1]);
      await sleep(T.swap);
      busy = false;
      scheduleHint();
      return;
    }

    await animateSwap(a, b, elA, elB);
    shownScore = game.score;
    const result = game.move(a, b);
    els.moves.textContent = game.movesLeft;
    els.movesStat.classList.toggle('low', game.movesLeft <= 5);
    for (const step of result.steps) await playStep(step);

    if (result.shuffled) {
      await toast('No moves left, shuffling');
      renderAll();
    }
    updateHud();
    busy = false;

    if (game.over) endLevel();
    else scheduleHint();
  }

  /* ---------- end of level ---------- */

  function endLevel() {
    const stars = game.stars;
    const won = game.won;
    els.modalTitle.textContent = won ? 'Level complete!' : 'Out of moves';
    els.modalStars.innerHTML = [1, 2, 3]
      .map((n) => `<span class="${n <= stars ? 'on' : 'off'}">★</span>`)
      .join('');
    els.modalText.textContent = won
      ? `You scored ${game.score.toLocaleString()} points with a best combo of x${game.bestCascade}.`
      : `You scored ${game.score.toLocaleString()} of ${game.level.target.toLocaleString()} points. Try again!`;
    const last = levelIndex === LEVELS.length - 1;
    els.nextBtn.style.display = won ? '' : 'none';
    els.nextBtn.textContent = last ? 'Play again' : 'Next level';
    els.overlay.classList.add('show');
    beep(won ? 660 : 220, 0.4, 'triangle');
  }

  function startLevel(index) {
    levelIndex = index;
    game = new Game(levelIndex);
    shownScore = 0;
    els.overlay.classList.remove('show');
    busy = false;
    deselect();
    renderAll();
    updateHud();
    scheduleHint();
  }

  /* ---------- input: swipe or tap-tap ---------- */

  function cellFromEvent(e) {
    const rect = boardEl.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / cell);
    const row = Math.floor((e.clientY - rect.top) / cell);
    return game.board.inBounds(row, col) ? [row, col] : null;
  }

  function deselect() {
    if (selected) {
      const el = tiles.get(game.board.grid[selected[0]][selected[1]].id);
      if (el) el.classList.remove('selected');
    }
    selected = null;
  }

  let drag = null;

  boardEl.addEventListener('pointerdown', (e) => {
    if (busy || game.over) return;
    const pos = cellFromEvent(e);
    if (!pos) return;
    drag = { pos, x: e.clientX, y: e.clientY, swiped: false };
    boardEl.setPointerCapture(e.pointerId);
  });

  boardEl.addEventListener('pointermove', (e) => {
    if (!drag || drag.swiped) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < cell * 0.35) return;
    drag.swiped = true;
    const [r, c] = drag.pos;
    const target = Math.abs(dx) > Math.abs(dy) ? [r, c + Math.sign(dx)] : [r + Math.sign(dy), c];
    if (game.board.inBounds(target[0], target[1])) trySwap(drag.pos, target);
  });

  boardEl.addEventListener('pointerup', () => {
    if (!drag) return;
    const { pos, swiped } = drag;
    drag = null;
    if (swiped || busy) return;
    if (selected && Math.abs(selected[0] - pos[0]) + Math.abs(selected[1] - pos[1]) === 1) {
      trySwap(selected, pos);
    } else if (selected && selected[0] === pos[0] && selected[1] === pos[1]) {
      deselect();
    } else {
      deselect();
      selected = pos;
      tileAt(pos).classList.add('selected');
      beep(520, 0.05);
    }
  });

  /* ---------- buttons ---------- */

  $('hintBtn').addEventListener('click', () => !busy && showHint());
  $('restartBtn').addEventListener('click', () => !busy && startLevel(levelIndex));
  $('retryBtn').addEventListener('click', () => startLevel(levelIndex));
  els.nextBtn.addEventListener('click', () => startLevel((levelIndex + 1) % LEVELS.length));
  $('soundBtn').addEventListener('click', (e) => {
    soundOn = !soundOn;
    e.target.textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');
    e.target.setAttribute('aria-pressed', String(soundOn));
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => !busy && renderAll(), 150);
  });

  startLevel(0);
})();
