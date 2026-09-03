// main.ts — application entry point: screens, networking and the game loop.

import { Net } from './net.js';
import { LocalPhysics, SnapshotBuffer } from './physics.js';
import { GameRenderer } from './renderer.js';
import {
  $,
  showScreen,
  showMenuError,
  showFormError,
  renderLobby,
  renderHUD,
  renderRoomList,
  renderGameOverPlayers,
  showToast,
} from './ui.js';
import type { Snapshot, RoomInfo } from './types.js';

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
let inputSeq = 0; // increments with every input change, used for reconciliation
let serverLastSeq = 0; // last input sequence acknowledged by the server
let frameCounter = 0;
let currentSides = 0;
let currentMyIndex = -1; // -1 = spectator (no face)
let wasAlive = true;
let playing = false;
let rafId = 0;
let intervalId: number | null = null;
let intervalMode = false;
let lastFrameTime = 0;
let lastLoopTick = 0;
let matchStartTime = 0;

const keys = { left: false, right: false };

let rooms: RoomInfo[] = [];
let lastLobbySig = '';
let lastGameOverSig = '';
let gameOverInitDone = false;
let joinRoomID = ''; // room selected on the join screen
let connContext: 'create' | 'join' | 'menu' = 'menu';
let myName = localStorage.getItem(NAME_KEY) || '';

function init(): void {
  bindCreatePanel();
  bindButtons();
  bindKeys();
  refreshRooms();

  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    openJoin(roomParam);
  } else {
    showScreen('menu');
  }

  window.setInterval(refreshRooms, 5000);
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

  const goLives = $('go-lives') as HTMLInputElement;
  const goAccel = $('go-accel') as HTMLInputElement;
  const goBall = $('go-ball') as HTMLInputElement;
  const goBallLabel = () => {
    $('go-ball-val').textContent = Number(goBall.value) === 0 ? 'выкл' : `${goBall.value} сек`;
  };
  goLives.addEventListener('input', () => {
    $('go-lives-val').textContent = goLives.value;
    sendConfig();
  });
  goAccel.addEventListener('change', sendConfig);
  goBall.addEventListener('input', () => {
    goBallLabel();
    sendConfig();
  });
  goBallLabel();
}

function sendConfig(): void {
  const lives = Number(($('go-lives') as HTMLInputElement).value);
  const accel = ($('go-accel') as HTMLInputElement).checked;
  const ball = Number(($('go-ball') as HTMLInputElement).value);
  net?.send({ action: 'config', lives, ballAccel: accel, addBallTime: ball });
}

function bindButtons(): void {
  // Main menu
  $('btn-create').addEventListener('click', openCreate);
  $('btn-refresh-rooms').addEventListener('click', refreshRooms);
  $('room-filter').addEventListener('input', renderRooms);
  $('room-state-filter').addEventListener('change', renderRooms);

  // Create room screen
  $('btn-create-go').addEventListener('click', createRoom);
  $('btn-create-back').addEventListener('click', backToMenu);

  // Join room screen
  $('btn-join').addEventListener('click', joinRoom);
  $('btn-join-back').addEventListener('click', backToMenu);
  $('join-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

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

  // Lobby / room screen
  $('btn-lobby-back').addEventListener('click', leaveToMenu);

  $('btn-restart').addEventListener('click', () => {
    $('game-over').classList.add('hidden');
    net?.send({ action: 'start' });
  });

  $('btn-again').addEventListener('click', leaveToMenu);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    // Don't swallow keys while the user is typing in a field.
    if (isTypingTarget(e.target)) return;
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
    if (isTypingTarget(e.target)) return;
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
  const me = latestSnap?.players.find((p) => p.id === meID);
  if (me && !me.isAlive) return; // spectators don't control a paddle

  const dir = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
  if (dir !== inputDir) {
    inputDir = dir;
    const screenDir = renderer ? renderer.getFaceScreenDirX() : 1;
    inputSeq++;
    net?.send({ action: 'move', dir: dir * screenDir, seq: inputSeq, lag: net.getLatency() });
  }
}

function captureName(form: 'create' | 'join'): string {
  const input = $(form === 'create' ? 'create-name' : 'join-name') as HTMLInputElement;
  const name = input.value.trim() || 'Player';
  myName = name;
  localStorage.setItem(NAME_KEY, name);
  return name;
}

function openCreate(): void {
  ($('create-name') as HTMLInputElement).value = myName;
  showFormError('create', null);
  showScreen('create');
}

function openJoin(roomID: string): void {
  joinRoomID = roomID;
  $('join-room-label').textContent = roomID;
  ($('join-name') as HTMLInputElement).value = myName;
  ($('join-pass') as HTMLInputElement).value = '';
  showFormError('join', null);
  showScreen('join');
  ($('join-name') as HTMLInputElement).focus();
}

function backToMenu(): void {
  joinRoomID = '';
  showFormError('create', null);
  showFormError('join', null);
  showMenuError(null);
  showScreen('menu');
  refreshRooms();
}

function showGlobalError(msg: string): void {
  showFormError('create', null);
  showFormError('join', null);
  showMenuError(msg);
  showScreen('menu');
  refreshRooms();
}

async function createRoom(): Promise<void> {
  const playerName = captureName('create');
  const name = ($('inp-room-name') as HTMLInputElement).value.trim();
  const pass = ($('inp-room-pass') as HTMLInputElement).value;
  const max = Number(($('inp-max') as HTMLInputElement).value);
  const lives = Number(($('inp-lives') as HTMLInputElement).value);
  const accel = ($('inp-accel') as HTMLInputElement).checked;
  const ball = Number(($('inp-ball') as HTMLInputElement).value);

  if (!name) {
    showFormError('create', 'Введите название комнаты');
    return;
  }

  try {
    const res = await fetch('/create-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        password: pass,
        maxPlayers: max,
        livesCount: lives,
        ballAccel: accel,
        addBallTime: ball,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showFormError('create', data.error || 'Не удалось создать комнату');
      return;
    }
    connContext = 'create';
    connect(data.roomID, pass, playerName);
  } catch {
    showFormError('create', 'Не удалось создать комнату. Сервер недоступен?');
  }
}

function joinRoom(): void {
  const playerName = captureName('join');
  const pass = ($('join-pass') as HTMLInputElement).value;
  if (!joinRoomID) {
    showFormError('join', 'Не выбрана комната');
    return;
  }
  connContext = 'join';
  connect(joinRoomID, pass, playerName);
}

function connect(roomID: string, password: string, name: string): void {
  myName = name;
  localStorage.setItem(NAME_KEY, name);

  net?.close();
  net = new Net(roomID, name, password, {
    onWelcome: (w) => {
      meID = w.you;
    },
    onSnapshot: handleSnapshot,
    onError: (m) => {
      net?.close();
      if (connContext === 'create') {
        showFormError('create', m);
        showScreen('create');
      } else {
        showFormError('join', m);
        showScreen('join');
      }
      refreshRooms();
    },
    onKicked: () => {
      net?.close();
      if (playing) stopLoop();
      showGlobalError('Вы были исключены из комнаты');
    },
    onClose: () => {
      if (playing) stopLoop();
      showGlobalError('Соединение с сервером потеряно');
    },
  });
  net.connect();
  showScreen('lobby');
  $('lobby-status').textContent = 'Подключение...';
}

function kickPlayer(id: string): void {
  net?.send({ action: 'kick', target: id });
}

function playersSignature(snap: Snapshot): string {
  return snap.players.map((p) => `${p.id}:${p.isHost}:${p.isAlive}`).join('|');
}

async function refreshRooms(): Promise<void> {
  // Only poll while the menu (with the room list) is on screen.
  if (!$('screen-menu').classList.contains('active')) return;
  try {
    const res = await fetch('/rooms');
    if (!res.ok) return;
    const data = await res.json();
    rooms = data.rooms || [];
    renderRooms();
  } catch {
    /* server unavailable */
  }
}

function renderRooms(): void {
  const filter = ($('room-filter') as HTMLInputElement).value;
  const stateFilter = ($('room-state-filter') as HTMLSelectElement).value;
  renderRoomList(rooms, filter, stateFilter, openJoin);
}

function handleSnapshot(snap: Snapshot): void {
  latestSnap = snap;
  buffer.push(snap);
  physics.sync(snap);
  physics.onSnapshot(snap);

  const me = snap.players.find((p) => p.id === snap.you);

  if (snap.state === 'waiting') {
    playing = false;
    showScreen('lobby');
    const sig = playersSignature(snap);
    if (sig !== lastLobbySig) {
      lastLobbySig = sig;
      renderLobby(snap, buildInviteLink(snap.roomID), kickPlayer);
    }
  } else if (snap.state === 'playing') {
    if (me) {
      serverMyAngle = me.angle;
      serverLastSeq = me.lastSeq ?? 0;
    }
    if (!playing) {
      startPlaying(snap);
    } else {
      if (me && !me.isAlive && wasAlive) {
        showToast('Вы выбыли — теперь вы наблюдатель');
      }
      if (me) wasAlive = me.isAlive;

      const myIdx = me && me.isAlive ? me.index : -1;
      if (snap.sides !== currentSides || myIdx !== currentMyIndex) {
        // The field re-formed after an elimination: reset interpolation state.
        buffer.clear();
        buffer.push(snap);
        setupField(snap);
      }
    }
  } else if (snap.state === 'ended') {
    showGameOver(snap);
  }
}

function setupField(snap: Snapshot): void {
  const me = snap.players.find((p) => p.id === snap.you);
  const myIndex = me && me.isAlive ? me.index : -1; // -1 = spectator

  if (!renderer) renderer = new GameRenderer($('game-canvas') as HTMLCanvasElement);
  renderer.resize();
  renderer.setup(snap.sides, snap.radius, snap.chamfer, snap.paddleHalf, snap.ballRadius, myIndex);
  physics.setup(snap.sides, snap.radius, snap.chamfer, snap.ballRadius);

  currentSides = snap.sides;
  currentMyIndex = myIndex;
}

function startPlaying(snap: Snapshot): void {
  playing = true;
  wasAlive = true;
  matchStartTime = performance.now();
  gameOverInitDone = false;

  const me = snap.players.find((p) => p.id === snap.you);
  myAngle = me ? me.angle : 0.5;
  serverMyAngle = myAngle;

  // Make the game screen visible BEFORE measuring the canvas, otherwise the
  // canvas backing store ends up 0x0 and nothing is drawn.
  $('game-over').classList.add('hidden');
  showScreen('game');

  setupField(snap);

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

  frameCounter++;
  if (frameCounter % 30 === 0) {
    const latency = net ? net.getLatency() : 60;
    physics.latencySec = latency / 1000;
    physics.setDelay(Math.round(latency) + 50);
  }

  physics.step(dt);
  stepMyPaddle(dt);

  if (renderer && latestSnap) {
    const renderTime = physics.renderTime;
    const players = buffer.playersAt(renderTime) ?? latestSnap.players;
    renderer.render({
      snap: latestSnap,
      players,
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
  } else if (inputSeq <= serverLastSeq) {
    // Our own paddle is rendered purely from local prediction (maximum
    // responsiveness). The server runs a fixed 60 Hz tick while we step every
    // animation frame, so after a move the server can differ from us by up to
    // ~1 tick (~6-7 px at 380 px/s). Easing toward the server for such noise is
    // what made the paddle "drift back" a few px after stopping, so we ignore
    // errors up to ~2 ticks and only correct a genuine divergence (e.g. an
    // input that never reached the server), eased back quickly.
    const tickTravel = (speed / faceLen) / 60; // fraction of the face per 60 Hz tick
    const deadZone = tickTravel * 2;
    const err = serverMyAngle - myAngle;
    if (Math.abs(err) > deadZone) {
      myAngle += err * Math.min(1, dt / 0.15);
    }
  }
}

function showGameOver(snap: Snapshot): void {
  stopLoop();
  showScreen('game');

  if (renderer && latestSnap) {
    const renderTime = physics.renderTime;
    const players = buffer.playersAt(renderTime) ?? latestSnap.players;
    renderer.render({
      snap: latestSnap,
      players,
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
  renderHUD(snap, (performance.now() - matchStartTime) / 1000);

  const me = snap.players.find((p) => p.id === snap.you);
  const isHost = !!me?.isHost;
  $('btn-restart').classList.toggle('hidden', !isHost);
  $('game-over-config').classList.toggle('hidden', !isHost);
  $('game-over-players').textContent = isHost
    ? `Игроков в комнате: ${snap.players.length} — настройте правила и нажмите «Играть снова»`
    : 'Ожидание перезапуска создателем...';

  if (!gameOverInitDone) {
    gameOverInitDone = true;
    const lives = snap.lives ?? 3;
    const accel = snap.ballAccel ?? true;
    const ball = snap.addBallTime ?? 15;
    ($('go-lives') as HTMLInputElement).value = String(lives);
    $('go-lives-val').textContent = String(lives);
    ($('go-accel') as HTMLInputElement).checked = accel;
    ($('go-ball') as HTMLInputElement).value = String(ball);
    $('go-ball-val').textContent = ball === 0 ? 'выкл' : `${ball} сек`;
  }

  const sig = playersSignature(snap);
  if (sig !== lastGameOverSig) {
    lastGameOverSig = sig;
    renderGameOverPlayers(snap, kickPlayer);
  }

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
  lastLobbySig = '';
  lastGameOverSig = '';
  gameOverInitDone = false;
  backToMenu();
}

function buildInviteLink(roomID: string): string {
  return `${location.origin}${location.pathname}?room=${roomID}`;
}

init();
