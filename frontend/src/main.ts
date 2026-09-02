// main.ts — application entry point: screens, networking and the game loop.

import { Net } from './net.js';
import { LocalPhysics, SnapshotBuffer } from './physics.js';
import { GameRenderer } from './renderer.js';
import { $, showScreen, showMenuError, renderLobby, renderHUD, showToast } from './ui.js';
import type { Snapshot } from './types.js';

const NAME_KEY = 'neonpong.name';

let net: Net | null = null;
let renderer: GameRenderer | null = null;
const physics = new LocalPhysics();
const buffer = new SnapshotBuffer();

let meID = '';
let latestSnap: Snapshot | null = null;
let myAngle = 0.5;
let serverMyAngle = 0.5;
let inputDir = 0; // -1 / 0 / +1 in screen direction
let wasAlive = true;
let playing = false;
let rafId = 0;
let intervalId: number | null = null;
let intervalMode = false;
let lastFrameTime = 0;
let lastLoopTick = 0;
let matchStartTime = 0;

const keys = { left: false, right: false };

function init(): void {
  const nameInput = $('player-name') as HTMLInputElement;
  const saved = localStorage.getItem(NAME_KEY);
  if (saved) nameInput.value = saved;

  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) ($('join-room-id') as HTMLInputElement).value = roomParam;

  bindCreatePanel();
  bindButtons();
  bindKeys();
  showScreen('menu');
}

function bindCreatePanel(): void {
  const max = $('inp-max') as HTMLInputElement;
  const lives = $('inp-lives') as HTMLInputElement;
  const ball = $('inp-ball') as HTMLInputElement;
  max.addEventListener('input', () => ($('val-max').textContent = max.value));
  lives.addEventListener('input', () => ($('val-lives').textContent = lives.value));
  const ballLabel = () => {
    $('val-ball').textContent = Number(ball.value) === 0 ? 'выкл' : `${ball.value} сек`;
  };
  ball.addEventListener('input', ballLabel);
  ballLabel();
}

function bindButtons(): void {
  $('btn-create').addEventListener('click', () => {
    $('create-panel').classList.toggle('hidden');
  });
  $('btn-create-go').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoom);

  $('btn-copy').addEventListener('click', async () => {
    const link = $('lobby-link') as HTMLInputElement;
    try {
      await navigator.clipboard.writeText(link.value);
      showToast('Ссылка скопирована');
    } catch {
      link.select();
    }
  });

  $('btn-start').addEventListener('click', () => {
    net?.send({ action: 'start' });
  });

  $('btn-restart').addEventListener('click', () => {
    $('game-over').classList.add('hidden');
    net?.send({ action: 'start' });
  });

  $('btn-again').addEventListener('click', leaveToMenu);
}

function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        e.preventDefault();
        setKey('left', true);
        break;
      case 'ArrowRight':
      case 'KeyD':
        e.preventDefault();
        setKey('right', true);
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        setKey('left', false);
        break;
      case 'ArrowRight':
      case 'KeyD':
        setKey('right', false);
        break;
    }
  });
}

function setKey(which: 'left' | 'right', down: boolean): void {
  keys[which] = down;
  const dir = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
  if (dir !== inputDir) {
    inputDir = dir;
    const screenDir = renderer ? renderer.getFaceScreenDirX() : 1;
    net?.send({ action: 'move', dir: dir * screenDir });
  }
}

function getPlayerName(): string {
  const name = ($('player-name') as HTMLInputElement).value.trim();
  return name || 'Player';
}

async function createRoom(): Promise<void> {
  showMenuError(null);
  const max = Number(($('inp-max') as HTMLInputElement).value);
  const lives = Number(($('inp-lives') as HTMLInputElement).value);
  const accel = ($('inp-accel') as HTMLInputElement).checked;
  const ball = Number(($('inp-ball') as HTMLInputElement).value);

  try {
    const res = await fetch('/create-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPlayers: max, livesCount: lives, ballAccel: accel, addBallTime: ball }),
    });
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    connect(data.roomID);
  } catch {
    showMenuError('Не удалось создать комнату. Сервер недоступен?');
  }
}

function joinRoom(): void {
  const id = ($('join-room-id') as HTMLInputElement).value.trim();
  if (!id) {
    showMenuError('Введите ID комнаты');
    return;
  }
  connect(id);
}

function connect(roomID: string): void {
  const name = getPlayerName();
  localStorage.setItem(NAME_KEY, name);
  showMenuError(null);

  net?.close();
  net = new Net(roomID, name, {
    onWelcome: (w) => {
      meID = w.you;
    },
    onSnapshot: handleSnapshot,
    onError: (m) => {
      net?.close();
      showScreen('menu');
      showMenuError(m);
    },
    onClose: () => {
      if (playing) stopLoop();
      showScreen('menu');
      showMenuError('Соединение с сервером потеряно');
    },
  });
  net.connect();
  showScreen('lobby');
  $('lobby-status').textContent = 'Подключение...';
}

function handleSnapshot(snap: Snapshot): void {
  latestSnap = snap;
  buffer.push(snap);
  physics.onSnapshot(snap);

  const me = snap.players.find((p) => p.id === snap.you);

  if (snap.state === 'waiting') {
    playing = false;
    showScreen('lobby');
    renderLobby(snap, buildInviteLink(snap.roomID));
  } else if (snap.state === 'playing') {
    if (me) serverMyAngle = me.angle;
    if (!playing) {
      startPlaying(snap);
    } else if (me && !me.isAlive && wasAlive) {
      showToast('Вы выбыли из матча');
    }
    if (me) wasAlive = me.isAlive;
  } else if (snap.state === 'ended') {
    showGameOver(snap);
  }
}

function startPlaying(snap: Snapshot): void {
  playing = true;
  wasAlive = true;
  matchStartTime = performance.now();

  const me = snap.players.find((p) => p.id === snap.you);
  const myIndex = me ? me.index : 0;
  myAngle = me ? me.angle : 0.5;
  serverMyAngle = myAngle;

  // Make the game screen visible BEFORE measuring the canvas, otherwise the
  // canvas backing store ends up 0x0 and nothing is drawn.
  $('game-over').classList.add('hidden');
  showScreen('game');

  if (!renderer) renderer = new GameRenderer($('game-canvas') as HTMLCanvasElement);
  renderer.resize();
  renderer.setup(snap.sides, snap.radius, snap.chamfer, snap.paddleHalf, snap.ballRadius, myIndex);
  physics.setup(snap.sides, snap.radius, snap.chamfer, snap.ballRadius, snap.ballSpeed);

  if (!rafId && intervalId === null) {
    lastFrameTime = performance.now();
    startLoop();
  }
}

function startLoop(): void {
  intervalMode = false;
  lastLoopTick = performance.now();
  rafId = requestAnimationFrame(frame);
  // Watchdog: if rAF is throttled/unavailable, fall back to a timer so the
  // game keeps running (embedded webviews, hidden tabs, headless browsers).
  window.setTimeout(loopWatchdog, 400);
}

function loopWatchdog(): void {
  if (!playing) return;
  if (performance.now() - lastLoopTick > 350 && !intervalMode) {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    intervalMode = true;
    intervalId = window.setInterval(() => frame(performance.now()), 1000 / 60);
  } else {
    window.setTimeout(loopWatchdog, 400);
  }
}

function frame(now: number): void {
  lastLoopTick = performance.now();
  if (playing && !intervalMode) {
    rafId = requestAnimationFrame(frame);
  }
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  physics.step(dt);
  stepMyPaddle(dt);

  if (renderer && latestSnap) {
    const interp = buffer.playersAt(physics.renderTime) ?? latestSnap.players;
    renderer.render({
      snap: latestSnap,
      players: interp,
      myAngle,
      balls: physics.getBalls(),
    });
    renderHUD(latestSnap, (now - matchStartTime) / 1000);
  }
}

function stepMyPaddle(dt: number): void {
  if (!latestSnap || !renderer) return;
  const me = latestSnap.players.find((p) => p.id === meID);
  if (!me || !me.isAlive) return;

  const dir = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
  const screenDir = renderer.getFaceScreenDirX();
  const faceLen = 2 * latestSnap.radius * Math.sin(Math.PI / latestSnap.sides);
  const speed = latestSnap.paddleSpeed || 380;
  const half = latestSnap.paddleHalf;

  if (dir !== 0) {
    myAngle += dir * screenDir * (speed / faceLen) * dt;
    myAngle = Math.max(half, Math.min(1 - half, myAngle));
  } else {
    // Gentle reconciliation to the authoritative server value while idle.
    myAngle += (serverMyAngle - myAngle) * Math.min(1, dt / 0.2);
  }
}

function showGameOver(snap: Snapshot): void {
  stopLoop();
  showScreen('game');

  if (renderer && latestSnap) {
    const interp = buffer.playersAt(physics.renderTime) ?? latestSnap.players;
    renderer.render({
      snap: latestSnap,
      players: interp,
      myAngle,
      balls: physics.getBalls(),
    });
  }

  const winner = snap.players.find((p) => p.id === snap.winner);
  let text: string;
  if (!winner) text = 'Ничья';
  else if (winner.id === meID) text = '🏆 Вы победили!';
  else text = `Победил: ${winner.name}`;
  $('game-over-text').textContent = text;

  const me = snap.players.find((p) => p.id === snap.you);
  const isHost = !!me?.isHost;
  $('btn-restart').classList.toggle('hidden', !isHost);
  $('game-over-players').textContent = isHost
    ? `Игроков в комнате: ${snap.players.length} — нажмите «Играть снова»`
    : 'Ожидание перезапуска создателем...';

  $('game-over').classList.remove('hidden');
}

function stopLoop(): void {
  playing = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function leaveToMenu(): void {
  stopLoop();
  net?.close();
  net = null;
  latestSnap = null;
  keys.left = keys.right = false;
  inputDir = 0;
  showScreen('menu');
}

function buildInviteLink(roomID: string): string {
  return `${location.origin}${location.pathname}?room=${roomID}`;
}

init();
