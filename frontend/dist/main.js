// ../frontend/src/net.ts
var Net = class {
  constructor(roomID, playerName, handlers) {
    this.roomID = roomID;
    this.playerName = playerName;
    this.handlers = handlers;
    this.ws = null;
    this.pingTimer = null;
    this.latencyMs = 60;
    this.closedByUser = false;
  }
  connect() {
    this.closedByUser = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?roomID=${encodeURIComponent(this.roomID)}&playerName=${encodeURIComponent(this.playerName)}`;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (m.type) {
        case "welcome":
          this.handlers.onWelcome(m);
          break;
        case "snapshot":
          this.handlers.onSnapshot(m);
          break;
        case "error":
          this.handlers.onError(m.message);
          break;
        case "pong": {
          const rtt = performance.now() - m.c;
          this.latencyMs = Math.max(30, Math.min(220, rtt / 2));
          break;
        }
      }
    };
    this.ws.onclose = () => {
      this.stopPing();
      if (!this.closedByUser) this.handlers.onClose();
    };
    this.ws.onerror = () => {
    };
    this.send({ action: "ping", c: performance.now() });
    this.pingTimer = window.setInterval(() => {
      this.send({ action: "ping", c: performance.now() });
    }, 3e3);
  }
  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  getLatency() {
    return this.latencyMs;
  }
  close() {
    this.closedByUser = true;
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  stopPing() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
};

// ../frontend/src/physics.ts
var RENDER_DELAY_MS = 80;
var LocalPhysics = class {
  constructor() {
    this.timeBase = false;
    this.refServerT = 0;
    this.refClientNow = 0;
    this.delayMs = RENDER_DELAY_MS;
  }
  sync(snap) {
    if (!this.timeBase) {
      this.refServerT = snap.t;
      this.refClientNow = performance.now();
      this.timeBase = true;
    }
  }
  /** Server's wall-clock time right now (estimated). */
  estimatedServerNow() {
    if (!this.timeBase) return 0;
    return this.refServerT + (performance.now() - this.refClientNow);
  }
  /** Adjust the interpolation delay based on measured network latency. */
  setDelay(ms) {
    this.delayMs = Math.max(40, Math.min(300, ms));
  }
  /** Server time at which we render: a little in the past to hide network jitter. */
  get renderTime() {
    return this.estimatedServerNow() - this.delayMs;
  }
};
var SnapshotBuffer = class {
  constructor() {
    this.snaps = [];
  }
  push(snap) {
    this.snaps.push(snap);
    if (this.snaps.length > 32) this.snaps.shift();
  }
  latest() {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }
  /** Finds the two snapshots bracketing `renderTime` and the blend factor f. */
  bracketing(renderTime) {
    const n = this.snaps.length;
    if (n === 0) return null;
    let a = this.snaps[0];
    let b = this.snaps[n - 1];
    for (let i = 0; i < n - 1; i++) {
      const s0 = this.snaps[i];
      const s1 = this.snaps[i + 1];
      if (renderTime >= s0.t && renderTime <= s1.t) {
        a = s0;
        b = s1;
        break;
      }
    }
    const span = b.t - a.t || 1;
    let f = (renderTime - a.t) / span;
    if (renderTime > b.t) f = 1;
    if (renderTime < a.t) f = 0;
    return [a, b, f];
  }
  /** Returns player paddles interpolated to the given server time. */
  playersAt(renderTime) {
    const br = this.bracketing(renderTime);
    if (!br) return null;
    const [a, b, f] = br;
    const byId = /* @__PURE__ */ new Map();
    for (const p of a.players) byId.set(p.id, p);
    const out = [];
    for (const pb of b.players) {
      const pa = byId.get(pb.id);
      if (!pa) {
        out.push(pb);
        continue;
      }
      out.push({
        ...pb,
        angle: pa.angle + (pb.angle - pa.angle) * f
      });
    }
    return out;
  }
  /** Returns balls interpolated to the given server time. */
  ballsAt(renderTime) {
    const br = this.bracketing(renderTime);
    if (!br) return null;
    const [a, b, f] = br;
    if (a.balls.length !== b.balls.length) return b.balls;
    return b.balls.map((bb, i) => {
      const ba = a.balls[i];
      return {
        x: ba.x + (bb.x - ba.x) * f,
        y: ba.y + (bb.y - ba.y) * f,
        vx: bb.vx,
        vy: bb.vy
      };
    });
  }
};

// ../frontend/src/geometry.ts
var PI = Math.PI;
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}
function mul(a, s) {
  return { x: a.x * s, y: a.y * s };
}
function len(a) {
  return Math.hypot(a.x, a.y);
}
function norm(a) {
  const l = len(a);
  if (l === 0) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}
function generatePolygon(sides, radius) {
  if (sides < 3) sides = 3;
  const out = [];
  for (let i = 0; i < sides; i++) {
    const angle = -PI / 2 + i * 2 * PI / sides;
    out.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return out;
}
function chamferVertices(vertices, r) {
  const n = vertices.length;
  if (n < 3) return vertices.slice();
  const a = new Array(n);
  const b = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n];
    const cur = vertices[i];
    const next = vertices[(i + 1) % n];
    a[i] = pointAlong(cur, prev, r);
    b[i] = pointAlong(cur, next, r);
  }
  const out = [b[0]];
  for (let i = 1; i < n; i++) {
    out.push(a[i], b[i]);
  }
  out.push(a[0]);
  return out;
}
function pointAlong(from, to, dist) {
  const d = sub(to, from);
  const l = len(d);
  if (l === 0) return { x: from.x, y: from.y };
  return add(from, mul(d, dist / l));
}
function faceMidAngle(sides, face) {
  return -PI / 2 + (face + 0.5) * (2 * PI / sides);
}
function buildWalls(sides, radius, chamfer) {
  const v = generatePolygon(sides, radius);
  const c = chamferVertices(v, chamfer);
  const walls = [];
  for (let i = 0; i < c.length; i++) {
    walls.push({ a: c[i], b: c[(i + 1) % c.length] });
  }
  return walls;
}

// ../frontend/src/renderer.ts
var PALETTE = ["#00f0ff", "#ff3df0", "#ffe600", "#39ff6a", "#ff7a00", "#9d6bff"];
function playerColor(index) {
  return PALETTE[(index % PALETTE.length + PALETTE.length) % PALETTE.length];
}
var GameRenderer = class {
  constructor(canvas) {
    this.canvas = canvas;
    this.walls = [];
    this.radius = 300;
    this.chamfer = 40;
    this.paddleHalf = 0.11;
    this.ballRadius = 9;
    this.sides = 6;
    this.myIndex = 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }
  setup(sides, radius, chamfer, paddleHalf, ballRadius, myIndex) {
    this.sides = sides;
    this.radius = radius;
    this.chamfer = chamfer;
    this.paddleHalf = paddleHalf;
    this.ballRadius = ballRadius;
    this.myIndex = myIndex;
    this.walls = buildWalls(sides, radius, chamfer);
  }
  /** Screen-space direction (+1/-1) along which "increasing angle" moves the paddle. */
  getFaceScreenDirX() {
    const seg = this.walls[2 * this.myIndex];
    if (!seg) return 1;
    const t = norm(sub(seg.b, seg.a));
    const faceAngle = faceMidAngle(this.sides, this.myIndex);
    const cam = Math.PI / 2 - faceAngle;
    const sx = t.x * Math.cos(cam) - t.y * Math.sin(cam);
    return sx >= 0 ? 1 : -1;
  }
  render(state) {
    const ctx = this.ctx;
    if (this.canvas.width === 0 || this.canvas.height === 0) this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, "#0a1020");
    bg.addColorStop(1, "#020409");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const faceAngle = faceMidAngle(this.sides, this.myIndex);
    const camAngle = Math.PI / 2 - faceAngle;
    const scale = this.fitScale(w, h);
    const cx = w / 2;
    const cy = h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(camAngle);
    ctx.scale(scale, scale);
    this.drawRing();
    this.drawArena(state);
    this.drawPaddles(state);
    this.drawBalls(state);
    ctx.restore();
    if (state.snap.state === "playing" && state.balls.length === 0 && state.snap.respawnIn && state.snap.respawnIn > 0) {
      this.drawCountdown(state.snap.respawnIn);
    }
  }
  drawCountdown(seconds) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 44px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#00f0ff";
    ctx.shadowBlur = 22;
    ctx.fillText(`\u041C\u044F\u0447 \u0447\u0435\u0440\u0435\u0437 ${Math.ceil(seconds)}`, this.canvas.width / 2, this.canvas.height / 2);
    ctx.restore();
  }
  fitScale(w, h) {
    const margin = this.chamfer + this.ballRadius * 3 + 30;
    return Math.min(w, h) / 2 / (this.radius + margin);
  }
  drawRing() {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(0,240,255,0.08)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius + this.chamfer, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  drawArena(state) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowBlur = 18;
    for (let i = 0; i < this.walls.length; i++) {
      const seg = this.walls[i];
      const isFace = i % 2 === 0;
      const faceIdx = i / 2;
      const player = isFace ? state.snap.players.find((p) => p.index === faceIdx) : void 0;
      if (isFace && player) {
        if (!player.isAlive) {
          ctx.shadowColor = "#ff2244";
          ctx.strokeStyle = "rgba(255,45,70,0.9)";
        } else {
          const col = playerColor(player.index);
          ctx.shadowColor = col;
          ctx.strokeStyle = col;
        }
      } else {
        ctx.shadowColor = "rgba(0,240,255,0.7)";
        ctx.strokeStyle = "rgba(0,240,255,0.45)";
      }
      ctx.lineWidth = isFace ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(seg.a.x, seg.a.y);
      ctx.lineTo(seg.b.x, seg.b.y);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawPaddles(state) {
    const ctx = this.ctx;
    const faceLen = 2 * this.radius * Math.sin(Math.PI / this.sides);
    const halfLen = faceLen * this.paddleHalf;
    for (const p of state.players) {
      if (!p.isAlive) continue;
      const seg = this.walls[2 * p.index];
      if (!seg) continue;
      const angle = p.id === state.snap.you ? state.myAngle : p.angle;
      const dir = norm(sub(seg.b, seg.a));
      const center = add(seg.a, mul(sub(seg.b, seg.a), angle));
      const a = add(center, mul(dir, -halfLen));
      const b = add(center, mul(dir, halfLen));
      const col = playerColor(p.index);
      ctx.save();
      ctx.lineCap = "round";
      ctx.shadowColor = col;
      ctx.shadowBlur = 24;
      ctx.strokeStyle = col;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.shadowBlur = 8;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }
  drawBalls(state) {
    const ctx = this.ctx;
    for (const b of state.balls) {
      ctx.save();
      ctx.shadowColor = "#00f0ff";
      ctx.shadowBlur = 12;
      const glowR = this.ballRadius * 1.7;
      const halo = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, glowR);
      halo.addColorStop(0, "rgba(255,255,255,0.95)");
      halo.addColorStop(0.45, "rgba(0,240,255,0.45)");
      halo.addColorStop(1, "rgba(0,240,255,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(b.x, b.y, this.ballRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
};

// ../frontend/src/ui.ts
function $(id) {
  return document.getElementById(id);
}
function showScreen(name) {
  ["menu", "lobby", "game"].forEach((s) => {
    $("screen-" + s).classList.toggle("active", s === name);
  });
}
function showMenuError(msg) {
  const box = $("menu-error");
  box.textContent = msg ?? "";
  box.classList.toggle("hidden", !msg);
}
function renderLobby(snap, link) {
  $("lobby-room-id").textContent = snap.roomID;
  $("lobby-link").value = link;
  const list = $("lobby-players");
  list.innerHTML = "";
  snap.players.forEach((p, i) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = playerColor(i);
    dot.style.color = playerColor(i);
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = p.name + (p.isHost ? " \u2605" : "");
    li.append(dot, name);
    list.appendChild(li);
  });
  const isHost = snap.players.some((p) => p.id === snap.you && p.isHost);
  $("btn-start").classList.toggle("hidden", !isHost);
  $("lobby-status").textContent = isHost ? "\u0412\u044B \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u044C \u2014 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041D\u0430\u0447\u0430\u0442\u044C \u0438\u0433\u0440\u0443\xBB, \u043A\u043E\u0433\u0434\u0430 \u0432\u0441\u0435 \u0433\u043E\u0442\u043E\u0432\u044B." : "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u0435\u043C...";
}
function renderHUD(snap, elapsedSec) {
  const wrap = $("hud-players");
  wrap.innerHTML = "";
  for (const p of snap.players) {
    const item = document.createElement("div");
    item.className = "hud-player" + (p.isAlive ? "" : " dead");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = playerColor(p.index);
    dot.style.color = playerColor(p.index);
    const name = document.createElement("span");
    name.textContent = p.name;
    const lives = document.createElement("span");
    lives.className = "lives";
    lives.textContent = p.isAlive ? "\u2665".repeat(Math.max(0, p.lives)) : "\u2715";
    item.append(dot, name, lives);
    wrap.appendChild(item);
  }
  const m = Math.floor(elapsedSec / 60);
  const s = Math.floor(elapsedSec % 60);
  $("hud-time").textContent = `${m}:${s.toString().padStart(2, "0")}`;
}
function showToast(msg, ms = 3e3) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  window.setTimeout(() => t.classList.add("hidden"), ms);
}

// ../frontend/src/main.ts
var NAME_KEY = "neonpong.name";
var net = null;
var renderer = null;
var physics = new LocalPhysics();
var buffer = new SnapshotBuffer();
var meID = "";
var latestSnap = null;
var myAngle = 0.5;
var serverMyAngle = 0.5;
var inputDir = 0;
var inputSeq = 0;
var serverLastSeq = 0;
var frameCounter = 0;
var wasAlive = true;
var playing = false;
var rafId = 0;
var intervalId = null;
var intervalMode = false;
var lastFrameTime = 0;
var lastLoopTick = 0;
var matchStartTime = 0;
var keys = { left: false, right: false };
function init() {
  const nameInput = $("player-name");
  const saved = localStorage.getItem(NAME_KEY);
  if (saved) nameInput.value = saved;
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam) $("join-room-id").value = roomParam;
  bindCreatePanel();
  bindButtons();
  bindKeys();
  showScreen("menu");
}
function bindCreatePanel() {
  const max = $("inp-max");
  const lives = $("inp-lives");
  const ball = $("inp-ball");
  max.addEventListener("input", () => $("val-max").textContent = max.value);
  lives.addEventListener("input", () => $("val-lives").textContent = lives.value);
  const ballLabel = () => {
    $("val-ball").textContent = Number(ball.value) === 0 ? "\u0432\u044B\u043A\u043B" : `${ball.value} \u0441\u0435\u043A`;
  };
  ball.addEventListener("input", ballLabel);
  ballLabel();
}
function bindButtons() {
  $("btn-create").addEventListener("click", () => {
    $("create-panel").classList.toggle("hidden");
  });
  $("btn-create-go").addEventListener("click", createRoom);
  $("btn-join").addEventListener("click", joinRoom);
  $("btn-copy").addEventListener("click", async () => {
    const link = $("lobby-link");
    try {
      await navigator.clipboard.writeText(link.value);
      showToast("\u0421\u0441\u044B\u043B\u043A\u0430 \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0430");
    } catch {
      link.select();
    }
  });
  $("btn-start").addEventListener("click", () => {
    net?.send({ action: "start" });
  });
  $("btn-restart").addEventListener("click", () => {
    $("game-over").classList.add("hidden");
    net?.send({ action: "start" });
  });
  $("btn-again").addEventListener("click", leaveToMenu);
}
function bindKeys() {
  window.addEventListener("keydown", (e) => {
    switch (e.code) {
      case "ArrowLeft":
      case "KeyA":
        e.preventDefault();
        setKey("left", true);
        break;
      case "ArrowRight":
      case "KeyD":
        e.preventDefault();
        setKey("right", true);
        break;
    }
  });
  window.addEventListener("keyup", (e) => {
    switch (e.code) {
      case "ArrowLeft":
      case "KeyA":
        setKey("left", false);
        break;
      case "ArrowRight":
      case "KeyD":
        setKey("right", false);
        break;
    }
  });
}
function setKey(which, down) {
  keys[which] = down;
  const dir = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
  if (dir !== inputDir) {
    inputDir = dir;
    const screenDir = renderer ? renderer.getFaceScreenDirX() : 1;
    inputSeq++;
    net?.send({ action: "move", dir: dir * screenDir, seq: inputSeq });
  }
}
function getPlayerName() {
  const name = $("player-name").value.trim();
  return name || "Player";
}
async function createRoom() {
  showMenuError(null);
  const max = Number($("inp-max").value);
  const lives = Number($("inp-lives").value);
  const accel = $("inp-accel").checked;
  const ball = Number($("inp-ball").value);
  try {
    const res = await fetch("/create-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxPlayers: max, livesCount: lives, ballAccel: accel, addBallTime: ball })
    });
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    connect(data.roomID);
  } catch {
    showMenuError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u043A\u043E\u043C\u043D\u0430\u0442\u0443. \u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D?");
  }
}
function joinRoom() {
  const id = $("join-room-id").value.trim();
  if (!id) {
    showMenuError("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 ID \u043A\u043E\u043C\u043D\u0430\u0442\u044B");
    return;
  }
  connect(id);
}
function connect(roomID) {
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
      showScreen("menu");
      showMenuError(m);
    },
    onClose: () => {
      if (playing) stopLoop();
      showScreen("menu");
      showMenuError("\u0421\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u043C \u043F\u043E\u0442\u0435\u0440\u044F\u043D\u043E");
    }
  });
  net.connect();
  showScreen("lobby");
  $("lobby-status").textContent = "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435...";
}
function handleSnapshot(snap) {
  latestSnap = snap;
  buffer.push(snap);
  physics.sync(snap);
  const me = snap.players.find((p) => p.id === snap.you);
  if (snap.state === "waiting") {
    playing = false;
    showScreen("lobby");
    renderLobby(snap, buildInviteLink(snap.roomID));
  } else if (snap.state === "playing") {
    if (me) {
      serverMyAngle = me.angle;
      serverLastSeq = me.lastSeq ?? 0;
    }
    if (!playing) {
      startPlaying(snap);
    } else if (me && !me.isAlive && wasAlive) {
      showToast("\u0412\u044B \u0432\u044B\u0431\u044B\u043B\u0438 \u0438\u0437 \u043C\u0430\u0442\u0447\u0430");
    }
    if (me) wasAlive = me.isAlive;
  } else if (snap.state === "ended") {
    showGameOver(snap);
  }
}
function startPlaying(snap) {
  playing = true;
  wasAlive = true;
  matchStartTime = performance.now();
  const me = snap.players.find((p) => p.id === snap.you);
  const myIndex = me ? me.index : 0;
  myAngle = me ? me.angle : 0.5;
  serverMyAngle = myAngle;
  $("game-over").classList.add("hidden");
  showScreen("game");
  if (!renderer) renderer = new GameRenderer($("game-canvas"));
  renderer.resize();
  renderer.setup(snap.sides, snap.radius, snap.chamfer, snap.paddleHalf, snap.ballRadius, myIndex);
  if (!rafId && intervalId === null) {
    lastFrameTime = performance.now();
    startLoop();
  }
}
function startLoop() {
  intervalMode = false;
  lastLoopTick = performance.now();
  rafId = requestAnimationFrame(frame);
  window.setTimeout(loopWatchdog, 400);
}
function loopWatchdog() {
  if (!playing) return;
  if (performance.now() - lastLoopTick > 350 && !intervalMode) {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    intervalMode = true;
    intervalId = window.setInterval(() => frame(performance.now()), 1e3 / 60);
  } else {
    window.setTimeout(loopWatchdog, 400);
  }
}
function frame(now) {
  lastLoopTick = performance.now();
  if (playing && !intervalMode) {
    rafId = requestAnimationFrame(frame);
  }
  const dt = Math.min(0.05, (now - lastFrameTime) / 1e3);
  lastFrameTime = now;
  frameCounter++;
  if (frameCounter % 30 === 0) {
    const latency = net ? net.getLatency() : 60;
    physics.setDelay(Math.round(latency) + 50);
  }
  stepMyPaddle(dt);
  if (renderer && latestSnap) {
    const renderTime = physics.renderTime;
    const players = buffer.playersAt(renderTime) ?? latestSnap.players;
    const balls = buffer.ballsAt(renderTime) ?? [];
    renderer.render({
      snap: latestSnap,
      players,
      myAngle,
      balls
    });
    renderHUD(latestSnap, (now - matchStartTime) / 1e3);
  }
}
function stepMyPaddle(dt) {
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
    myAngle += (serverMyAngle - myAngle) * Math.min(1, dt / 0.2);
  }
}
function showGameOver(snap) {
  stopLoop();
  showScreen("game");
  if (renderer && latestSnap) {
    const renderTime = physics.renderTime;
    const players = buffer.playersAt(renderTime) ?? latestSnap.players;
    const balls = buffer.ballsAt(renderTime) ?? [];
    renderer.render({
      snap: latestSnap,
      players,
      myAngle,
      balls
    });
  }
  const winner = snap.players.find((p) => p.id === snap.winner);
  let text;
  if (!winner) text = "\u041D\u0438\u0447\u044C\u044F";
  else if (winner.id === meID) text = "\u{1F3C6} \u0412\u044B \u043F\u043E\u0431\u0435\u0434\u0438\u043B\u0438!";
  else text = `\u041F\u043E\u0431\u0435\u0434\u0438\u043B: ${winner.name}`;
  $("game-over-text").textContent = text;
  const me = snap.players.find((p) => p.id === snap.you);
  const isHost = !!me?.isHost;
  $("btn-restart").classList.toggle("hidden", !isHost);
  $("game-over-players").textContent = isHost ? `\u0418\u0433\u0440\u043E\u043A\u043E\u0432 \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0435: ${snap.players.length} \u2014 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u0418\u0433\u0440\u0430\u0442\u044C \u0441\u043D\u043E\u0432\u0430\xBB` : "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u0435\u043C...";
  $("game-over").classList.remove("hidden");
}
function stopLoop() {
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
function leaveToMenu() {
  stopLoop();
  net?.close();
  net = null;
  latestSnap = null;
  keys.left = keys.right = false;
  inputDir = 0;
  showScreen("menu");
}
function buildInviteLink(roomID) {
  return `${location.origin}${location.pathname}?room=${roomID}`;
}
init();
