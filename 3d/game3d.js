/*
 * Gem Cascade 3D renderer.
 * Uses the exact same engine as the 2D game (src/core.js) and draws it with
 * Three.js: lit 3D gems, a tilted board, particle bursts and shockwaves.
 * The engine returns each cascade as an animation step, so this file only
 * has to turn those steps into tweens, just like src/ui.js does for the DOM.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const { Game, LEVELS, SPECIAL } = window.GemCascade;

const T = { swap: 190, clear: 240, fall: 380, pause: 70 };
const COMBO_WORDS = ['', '', 'Nice!', 'Great!', 'Amazing!', 'Spectacular!'];
const COLORS = [0xff3b3b, 0xff9a1f, 0xffd60a, 0x2fd16a, 0x2a9dff, 0xb44dff];
const TILT = THREE.MathUtils.degToRad(16);
const FOV = 34;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('canvas');
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
};

/* ---------- renderer and scene ---------- */

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (e) {
  stage.innerHTML = '<p class="nogl">This browser could not start WebGL.<a href="../">Play the 2D version</a></p>';
  throw e;
}
$('loading').remove();
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(-4, 7, 10);
const rimLight = new THREE.DirectionalLight(0xff7eb6, 0.9);
rimLight.position.set(6, -5, 3);
scene.add(keyLight, rimLight, new THREE.AmbientLight(0x8070c0, 0.35));

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
const camBase = new THREE.Vector3();

// New gems fall in from above the board; this plane hides them until they cross the top edge.
const topClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 4);

const boardGroup = new THREE.Group();
const gemGroup = new THREE.Group();
const fxGroup = new THREE.Group();
scene.add(boardGroup, gemGroup, fxGroup);

/* ---------- gem geometry and materials ---------- */

function starShape(outer, inner) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  return s;
}

// One shape per color, matching the 2D game so the board stays readable for color blind players.
const GEOMS = [
  new THREE.SphereGeometry(0.4, 40, 28), // red circle
  new RoundedBoxGeometry(0.64, 0.64, 0.64, 4, 0.13), // orange square
  new THREE.OctahedronGeometry(0.47), // yellow diamond
  (() => {
    const g = new THREE.ConeGeometry(0.46, 0.78, 3); // green triangle
    g.translate(0, -0.05, 0);
    return g;
  })(),
  (() => {
    const g = new THREE.CylinderGeometry(0.42, 0.42, 0.4, 6); // blue hexagon
    g.rotateX(Math.PI / 2);
    g.rotateZ(Math.PI / 6);
    return g;
  })(),
  (() => {
    const g = new THREE.ExtrudeGeometry(starShape(0.48, 0.21), {
      depth: 0.18,
      bevelEnabled: true,
      bevelThickness: 0.07,
      bevelSize: 0.05,
      bevelSegments: 2,
    }); // purple star
    g.center();
    return g;
  })(),
];
const RAINBOW_GEOM = new THREE.IcosahedronGeometry(0.42, 0);

function gemMaterial(type) {
  if (type < 0) {
    return new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.08,
      metalness: 0.25,
      clearcoat: 1,
      iridescence: 1,
      iridescenceIOR: 1.6,
      flatShading: true,
      emissive: 0xffffff,
      emissiveIntensity: 0.25,
      clippingPlanes: [topClip],
    });
  }
  return new THREE.MeshPhysicalMaterial({
    color: COLORS[type],
    roughness: 0.2,
    metalness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    emissive: COLORS[type],
    emissiveIntensity: 0.08,
    envMapIntensity: 0.55,
    flatShading: type >= 2 && type <= 4,
    clippingPlanes: [topClip],
  });
}

const glowMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.9,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  clippingPlanes: [topClip],
});
const bombMat = glowMat.clone();
bombMat.color.set(0xffd27a);
const RING = new THREE.TorusGeometry(0.5, 0.04, 10, 48);
const ORB = new THREE.SphereGeometry(0.07, 12, 8);
const orbMats = COLORS.map((c) => new THREE.MeshBasicMaterial({ color: c, clippingPlanes: [topClip] }));

// Line gems get a glowing ring around them (horizontal or vertical),
// bombs get two spinning rings like a gyroscope, rainbow gems get orbiting orbs.
function buildDecoration(special) {
  if (special === SPECIAL.NONE) return null;
  const deco = new THREE.Group();
  deco.userData.special = special;
  if (special === SPECIAL.LINE_H || special === SPECIAL.LINE_V) {
    for (const offset of [-0.16, 0.16]) {
      const ring = new THREE.Mesh(RING, glowMat);
      ring.scale.setScalar(0.92);
      if (special === SPECIAL.LINE_H) {
        ring.rotation.x = Math.PI / 2;
        ring.position.y = offset;
      } else {
        ring.rotation.y = Math.PI / 2;
        ring.position.x = offset;
      }
      deco.add(ring);
    }
  } else if (special === SPECIAL.BOMB) {
    const a = new THREE.Mesh(RING, bombMat);
    const b = new THREE.Mesh(RING, bombMat);
    a.scale.setScalar(1.05);
    b.scale.setScalar(1.05);
    deco.add(a, b);
  } else if (special === SPECIAL.RAINBOW) {
    COLORS.forEach((_, i) => {
      const orb = new THREE.Mesh(ORB, orbMats[i]);
      orb.userData.angle = (i / COLORS.length) * Math.PI * 2;
      deco.add(orb);
    });
  }
  return deco;
}

function animateDecoration(deco, time, phase) {
  const special = deco.userData.special;
  if (special === SPECIAL.LINE_H || special === SPECIAL.LINE_V) {
    const s = 1 + Math.sin(time * 5 + phase) * 0.06;
    deco.scale.setScalar(s);
  } else if (special === SPECIAL.BOMB) {
    deco.children[0].rotation.set(time * 2.2, time * 1.3, 0);
    deco.children[1].rotation.set(-time * 1.4, 0, time * 2.4);
  } else if (special === SPECIAL.RAINBOW) {
    for (const orb of deco.children) {
      const a = orb.userData.angle + time * 2.5;
      orb.position.set(Math.cos(a) * 0.56, Math.sin(a * 2) * 0.12, Math.sin(a) * 0.56);
    }
    deco.rotation.x = 0.5;
  }
}

/* ---------- state ---------- */

let game;
let levelIndex = 0;
let busy = false;
let selected = null;
let hintTimer = null;
let soundOn = true;
let shownScore = 0;
let stageSize = { w: 300, h: 300 };
let cellTiles = [];
const gems = new Map(); // tile id -> gem object

const cx = (col) => col - (game.board.cols - 1) / 2;
const cy = (row) => (game.board.rows - 1) / 2 - row;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- tweens ---------- */

const tweens = new Set();
const ease = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inBack: (t) => 2.2 * t * t * t - 1.2 * t * t,
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

function animate(duration, update, easing = ease.outCubic) {
  return new Promise((resolve) => {
    tweens.add({ start: performance.now(), duration, update, easing, resolve });
  });
}

function runTweens(now) {
  for (const tw of tweens) {
    const t = Math.min(1, Math.max(0, (now - tw.start) / tw.duration));
    tw.update(tw.easing(t), t);
    if (t >= 1) {
      tweens.delete(tw);
      tw.resolve();
    }
  }
}

/* ---------- sound (same tiny WebAudio blips as the 2D game) ---------- */

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

/* ---------- board and gems ---------- */

function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      if (o.isMesh && o.material && o.material.userData.owned) o.material.dispose();
    });
  }
}

function buildBoard() {
  clearGroup(boardGroup);
  clearGroup(gemGroup);
  clearGroup(fxGroup);
  gems.clear();
  particles.length = 0;

  const { rows, cols } = game.board;
  topClip.constant = rows / 2 + 0.02;

  const frame = new THREE.Mesh(
    new RoundedBoxGeometry(cols + 0.5, rows + 0.5, 0.3, 4, 0.28),
    new THREE.MeshStandardMaterial({ color: 0x140a2c, roughness: 0.5, metalness: 0.3 })
  );
  frame.position.z = -0.72;
  boardGroup.add(frame);

  const tileGeom = new RoundedBoxGeometry(0.94, 0.94, 0.08, 2, 0.14);
  cellTiles = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const mat = new THREE.MeshStandardMaterial({
        color: (r + c) % 2 ? 0x2a1852 : 0x34205f,
        roughness: 0.7,
        emissive: 0xffcf4a,
        emissiveIntensity: 0,
      });
      mat.userData.owned = true;
      const tile = new THREE.Mesh(tileGeom, mat);
      tile.position.set(cx(c), cy(r), -0.52);
      boardGroup.add(tile);
      row.push(tile);
    }
    cellTiles.push(row);
  }

  const pos = game.board.positions();
  for (const id in pos) makeGem(Number(id), pos[id], pos[id].row, pos[id].col);
}

function makeGem(id, info, row, col) {
  const group = new THREE.Group();
  const material = gemMaterial(info.type);
  material.userData.owned = true;
  const body = new THREE.Mesh(info.type < 0 ? RAINBOW_GEOM : GEOMS[info.type], material);
  group.add(body);
  group.position.set(cx(col), cy(row), 0);
  const gem = {
    id,
    group,
    body,
    type: info.type,
    special: SPECIAL.NONE,
    deco: null,
    phase: Math.random() * Math.PI * 2,
    selected: false,
    hint: false,
  };
  applyInfo(gem, info);
  gemGroup.add(group);
  gems.set(id, gem);
  return gem;
}

// Update a gem's shape and special decoration (used when a match upgrades it).
function applyInfo(gem, info) {
  if (gem.type !== info.type) {
    gem.body.geometry = info.type < 0 ? RAINBOW_GEOM : GEOMS[info.type];
    gem.body.material.dispose();
    gem.body.material = gemMaterial(info.type);
    gem.body.material.userData.owned = true;
    gem.type = info.type;
  }
  if (gem.special !== info.special) {
    if (gem.deco) gem.group.remove(gem.deco);
    gem.deco = buildDecoration(info.special);
    if (gem.deco) gem.group.add(gem.deco);
    gem.special = info.special;
  }
}

function removeGem(gem) {
  gemGroup.remove(gem.group);
  gem.body.material.dispose();
  gems.delete(gem.id);
}

function gemAt(pos) {
  return gems.get(game.board.grid[pos[0]][pos[1]].id);
}

/* ---------- effects ---------- */

const particles = [];
const PART_GEOM = new THREE.OctahedronGeometry(0.09);
const partMats = [...COLORS, 0xffffff].map((c) => new THREE.MeshBasicMaterial({ color: c }));

function burst(x, y, type, count) {
  if (reduceMotion) count = Math.min(count, 3);
  const mat = partMats[type >= 0 ? type : COLORS.length];
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(PART_GEOM, mat);
    mesh.position.set(x, y, 0.2);
    const a = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 2.5;
    fxGroup.add(mesh);
    particles.push({
      mesh,
      vel: new THREE.Vector3(Math.cos(a) * speed, Math.sin(a) * speed + 1.5, 1 + Math.random() * 2.5),
      spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0),
      life: 0.7,
      max: 0.7,
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      fxGroup.remove(p.mesh);
      particles.splice(i, 1);
      continue;
    }
    p.vel.y -= 9 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.rotation.x += p.spin.x * dt;
    p.mesh.rotation.y += p.spin.y * dt;
    p.mesh.scale.setScalar(p.life / p.max);
  }
}

function shockwave(x, y, special) {
  const mat = new THREE.MeshBasicMaterial({
    color: special === SPECIAL.BOMB ? 0xffd27a : 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 8, 48), mat);
  ring.position.set(x, y, 0.1);
  fxGroup.add(ring);
  const sx = special === SPECIAL.LINE_V ? 0.8 : special === SPECIAL.BOMB ? 3.2 : game.board.cols;
  const sy = special === SPECIAL.LINE_H ? 0.8 : special === SPECIAL.BOMB ? 3.2 : game.board.rows;
  animate(420, (t) => {
    ring.scale.set(0.3 + sx * t, 0.3 + sy * t, 1);
    mat.opacity = 1 - t;
  }).then(() => {
    fxGroup.remove(ring);
    ring.geometry.dispose();
    mat.dispose();
  });
  shake = Math.max(shake, special === SPECIAL.RAINBOW ? 0.25 : 0.14);
}

/* ---------- camera, layout and render loop ---------- */

let shake = 0;
const parallax = { x: 0, y: 0, tx: 0, ty: 0 };

function layout() {
  const { rows, cols } = game.board;
  const app = document.querySelector('.app');
  const w = Math.max(240, Math.min(app.clientWidth, 520));
  const h = Math.round(w * ((rows + 0.9) / (cols + 0.9)));
  stageSize = { w, h };
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  renderer.setSize(w, h);

  camera.aspect = w / h;
  const halfH = rows / 2 + 0.45;
  const halfW = cols / 2 + 0.45;
  const dist = (Math.max(halfH, halfW / camera.aspect) / Math.tan(THREE.MathUtils.degToRad(FOV / 2))) * 1.1;
  camBase.set(0, -Math.sin(TILT) * dist, Math.cos(TILT) * dist);
  camera.updateProjectionMatrix();
  placeCamera();
}

function placeCamera() {
  camera.position.copy(camBase);
  if (!reduceMotion) {
    camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), parallax.x * 0.07);
    camera.position.applyAxisAngle(new THREE.Vector3(1, 0, 0), -parallax.y * 0.05);
    if (shake > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
    }
  }
  camera.lookAt(0, 0, 0);
}

const clock = new THREE.Clock();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  runTweens(now);

  for (const gem of gems.values()) {
    const b = gem.body;
    if (gem.type < 0) {
      b.rotation.set(time * 0.7, time * 1.2, 0);
      b.material.color.setHSL((time * 0.2 + gem.phase) % 1, 0.85, 0.62);
      b.material.emissive.copy(b.material.color);
    } else if (gem.type !== 0) {
      b.rotation.y = Math.sin(time * 0.9 + gem.phase) * 0.45;
    }
    let s = 1;
    if (gem.selected) s = 1.18 + Math.sin(time * 8) * 0.03;
    else if (gem.hint) s = 1 + 0.14 * (0.5 + 0.5 * Math.sin(time * 7));
    b.scale.setScalar(THREE.MathUtils.lerp(b.scale.x, s, 0.25));
    b.position.z = THREE.MathUtils.lerp(b.position.z, gem.selected ? 0.3 : 0, 0.25);
    if (gem.type >= 0) b.material.emissiveIntensity = gem.selected || gem.hint ? 0.35 : 0.08;
    if (gem.deco) animateDecoration(gem.deco, time, gem.phase);
  }

  updateParticles(dt);
  parallax.x += (parallax.tx - parallax.x) * 0.06;
  parallax.y += (parallax.ty - parallax.y) * 0.06;
  shake *= 0.88;
  placeCamera();
  renderer.render(scene, camera);
}

/* ---------- HUD ---------- */

function updateHud() {
  const { score, movesLeft, level } = game;
  els.score.textContent = score.toLocaleString();
  els.target.textContent = level.target.toLocaleString();
  els.moves.textContent = movesLeft;
  els.movesStat.classList.toggle('low', movesLeft <= 5);
  els.levelName.textContent = level.name;
  els.progress.style.width = Math.min(100, (score / (level.target * 2)) * 100) + '%';
}

function updateHudPartial(points) {
  shownScore += points;
  els.score.textContent = shownScore.toLocaleString();
  els.progress.style.width = Math.min(100, (shownScore / (game.level.target * 2)) * 100) + '%';
}

function toScreen(x, y, z = 0.4) {
  const v = new THREE.Vector3(x, y, z).project(camera);
  return { x: ((v.x + 1) / 2) * stageSize.w, y: ((1 - v.y) / 2) * stageSize.h };
}

function floater(text, y, combo) {
  const p = toScreen(0, y);
  const el = document.createElement('div');
  el.className = 'floater' + (combo ? ' combo' : '');
  el.textContent = text;
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
  stage.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

async function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  stage.appendChild(el);
  await sleep(900);
  el.remove();
}

/* ---------- hints and selection ---------- */

function clearHint() {
  clearTimeout(hintTimer);
  gems.forEach((g) => (g.hint = false));
}

function showHint() {
  clearHint();
  const hint = game.board.findHint();
  if (hint) for (const pos of hint) gemAt(pos).hint = true;
}

function scheduleHint() {
  clearHint();
  hintTimer = setTimeout(() => !busy && !game.over && showHint(), 7000);
}

function setTileGlow(pos, on) {
  const tile = cellTiles[pos[0]] && cellTiles[pos[0]][pos[1]];
  if (tile) tile.material.emissiveIntensity = on ? 0.35 : 0;
}

function deselect() {
  if (selected) {
    const gem = gemAt(selected);
    if (gem) gem.selected = false;
    setTileGlow(selected, false);
  }
  selected = null;
}

function select(pos) {
  deselect();
  selected = pos;
  gemAt(pos).selected = true;
  setTileGlow(pos, true);
  beep(520, 0.05);
}

/* ---------- turn animation ---------- */

// Swap two gems along an arc: one passes in front, the other behind.
function moveGems(moves, duration) {
  const from = moves.map(([gem]) => gem.group.position.clone());
  return animate(
    duration,
    (t) => {
      moves.forEach(([gem, to], i) => {
        const p = gem.group.position;
        p.x = THREE.MathUtils.lerp(from[i].x, cx(to[1]), t);
        p.y = THREE.MathUtils.lerp(from[i].y, cy(to[0]), t);
        p.z = Math.sin(t * Math.PI) * (i === 0 ? 0.6 : -0.4);
      });
    },
    ease.inOutSine
  );
}

async function playStep(step) {
  // 1. Specials caught in this step fire with a shockwave, then cleared gems burst.
  const cleared = step.clearedIds.map((id) => gems.get(id)).filter(Boolean);
  for (const gem of cleared) {
    const { x, y } = gem.group.position;
    if (gem.special !== SPECIAL.NONE) shockwave(x, y, gem.special);
    burst(x, y, gem.type, 7);
  }
  beep(400 + step.cascade * 120, 0.12, 'triangle');
  await animate(
    T.clear,
    (t) => {
      for (const gem of cleared) {
        gem.group.scale.setScalar(Math.max(0.001, 1 - t));
        gem.group.rotation.z = t * 2.5;
      }
    },
    ease.inBack
  );
  cleared.forEach(removeGem);

  // 2. Gems upgraded to specials pop.
  for (const c of step.created) {
    const gem = gems.get(c.id);
    if (!gem) continue;
    applyInfo(gem, step.positions[c.id]);
    animate(320, (t) => gem.group.scale.setScalar(1.6 - 0.6 * t), ease.outBack);
    beep(880, 0.2, 'square');
  }

  // 3. New gems spawn above the board and everything falls into place.
  for (const s of step.spawned) makeGem(s.id, step.positions[s.id], s.from, s.col);
  const falling = [];
  for (const [id, gem] of gems) {
    const p = step.positions[id];
    if (!p) continue;
    const fromY = gem.group.position.y;
    const toY = cy(p.row);
    if (Math.abs(fromY - toY) > 0.001) falling.push([gem, fromY, toY]);
    gem.group.position.x = cx(p.col);
  }

  floater('+' + step.points, 1, false);
  if (step.cascade >= 2) floater(COMBO_WORDS[Math.min(step.cascade, 5)], 2.2, true);
  updateHudPartial(step.points);

  await animate(
    T.fall,
    (t) => {
      for (const [gem, fromY, toY] of falling) gem.group.position.y = THREE.MathUtils.lerp(fromY, toY, t);
    },
    ease.outBack
  );
  await sleep(T.pause);
}

// Move every gem to where the engine says it is (used after a shuffle).
async function syncToBoard() {
  const pos = game.board.positions();
  if (Object.keys(pos).some((id) => !gems.has(Number(id)))) {
    buildBoard();
    return;
  }
  const moves = Object.entries(pos).map(([id, p]) => {
    const gem = gems.get(Number(id));
    return [gem, gem.group.position.clone(), p];
  });
  await animate(
    T.fall * 1.6,
    (t) => {
      for (const [gem, from, p] of moves) {
        gem.group.position.set(
          THREE.MathUtils.lerp(from.x, cx(p.col), t),
          THREE.MathUtils.lerp(from.y, cy(p.row), t),
          Math.sin(t * Math.PI) * 1.2
        );
      }
    },
    ease.inOutSine
  );
}

async function trySwap(a, b) {
  if (busy || game.over) return;
  busy = true;
  clearHint();
  deselect();
  const gemA = gemAt(a);
  const gemB = gemAt(b);

  if (!game.board.isValidSwap(a, b)) {
    beep(160, 0.15, 'sawtooth');
    await moveGems([[gemA, b], [gemB, a]], T.swap);
    await moveGems([[gemA, a], [gemB, b]], T.swap);
    busy = false;
    scheduleHint();
    return;
  }

  await moveGems([[gemA, b], [gemB, a]], T.swap);
  shownScore = game.score;
  const result = game.move(a, b);
  els.moves.textContent = game.movesLeft;
  els.movesStat.classList.toggle('low', game.movesLeft <= 5);
  for (const step of result.steps) await playStep(step);

  if (result.shuffled) {
    await toast('No moves left, shuffling');
    await syncToBoard();
  }
  updateHud();
  busy = false;

  if (game.over) endLevel();
  else scheduleHint();
}

/* ---------- levels ---------- */

function endLevel() {
  const stars = game.stars;
  const won = game.won;
  els.modalTitle.textContent = won ? 'Level complete!' : 'Out of moves';
  els.modalStars.innerHTML = [1, 2, 3].map((n) => `<span class="${n <= stars ? 'on' : 'off'}">★</span>`).join('');
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
  selected = null;
  buildBoard();
  layout();
  updateHud();
  scheduleHint();
}

/* ---------- input: swipe or tap-tap, picked with a raycast onto the board plane ---------- */

const raycaster = new THREE.Raycaster();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const ndc = new THREE.Vector2();

function boardPoint(e) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(boardPlane, p) ? p : null;
}

function cellOf(p) {
  if (!p) return null;
  const col = Math.round(p.x + (game.board.cols - 1) / 2);
  const row = Math.round((game.board.rows - 1) / 2 - p.y);
  return game.board.inBounds(row, col) ? [row, col] : null;
}

let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  if (busy || game.over) return;
  const p = boardPoint(e);
  const pos = cellOf(p);
  if (!pos) return;
  drag = { pos, start: p, swiped: false };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  parallax.tx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  parallax.ty = ((e.clientY - rect.top) / rect.height) * 2 - 1;
  if (!drag || drag.swiped) return;
  const p = boardPoint(e);
  if (!p) return;
  const dx = p.x - drag.start.x;
  const dy = drag.start.y - p.y; // screen down is board row + 1
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.35) return;
  drag.swiped = true;
  const [r, c] = drag.pos;
  const target = Math.abs(dx) > Math.abs(dy) ? [r, c + Math.sign(dx)] : [r + Math.sign(dy), c];
  if (game.board.inBounds(target[0], target[1])) trySwap(drag.pos, target);
});

canvas.addEventListener('pointerleave', () => {
  parallax.tx = 0;
  parallax.ty = 0;
});

canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  const { pos, swiped } = drag;
  drag = null;
  if (swiped || busy) return;
  if (selected && Math.abs(selected[0] - pos[0]) + Math.abs(selected[1] - pos[1]) === 1) {
    trySwap(selected, pos);
  } else if (selected && selected[0] === pos[0] && selected[1] === pos[1]) {
    deselect();
  } else {
    select(pos);
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
  resizeTimer = setTimeout(layout, 150);
});

startLevel(0);
requestAnimationFrame(frame);

// Small hook for automated browser tests: screen position of a cell, and the live game.
window.gemCascade3d = {
  get game() {
    return game;
  },
  get busy() {
    return busy;
  },
  rebuild() {
    buildBoard();
  },
  cellToClient(row, col) {
    const rect = canvas.getBoundingClientRect();
    const p = toScreen(cx(col), cy(row), 0);
    return { x: rect.left + p.x, y: rect.top + p.y };
  },
};
