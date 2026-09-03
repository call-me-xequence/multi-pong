// frontend/src/net.ts
var Net = class {
  constructor(roomID, playerName, password, handlers) {
    this.roomID = roomID;
    this.playerName = playerName;
    this.password = password;
    this.handlers = handlers;
    this.ws = null;
    this.pingTimer = null;
    this.latencyMs = 60;
    this.closedByUser = false;
  }
  connect() {
    this.closedByUser = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?roomID=${encodeURIComponent(this.roomID)}&playerName=${encodeURIComponent(this.playerName)}&password=${encodeURIComponent(this.password)}`;
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
        case "kicked":
          this.handlers.onKicked();
          break;
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

// frontend/src/geometry.ts
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
function dot(a, b) {
  return a.x * b.x + a.y * b.y;
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
function closestPointOnSegment(p, s) {
  const ab = sub(s.b, s.a);
  const ap = sub(p, s.a);
  const lenSq = dot(ab, ab);
  let t = 0;
  if (lenSq > 0) {
    t = dot(ap, ab) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  return add(s.a, mul(ab, t));
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

// frontend/src/physics.ts
var RENDER_DELAY_MS = 80;
var CORRECTION_MS = 100;
var CORRECTION_THRESHOLD = 20;
var MAX_FRAME_DT = 0.05;
var LocalPhysics = class {
  constructor() {
    this.walls = [];
    this.ballRadius = 9;
    this.balls = [];
    this.corrections = [];
    // One-way network latency in seconds; used to align predicted balls with
    // authoritative snapshots (server state is this far in the past).
    this.latencySec = 0.06;
    this.timeBase = false;
    this.refServerT = 0;
    this.refClientNow = 0;
    this.delayMs = RENDER_DELAY_MS;
  }
  setup(sides, radius, chamfer, ballRadius) {
    this.walls = buildWalls(sides, radius, chamfer);
    this.ballRadius = ballRadius;
  }
  /** Establishes the client<->server clock mapping. */
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
  /** Adjust the interpolation delay (for other players' paddles). */
  setDelay(ms) {
    this.delayMs = Math.max(40, Math.min(300, ms));
  }
  get renderTime() {
    return this.estimatedServerNow() - this.delayMs;
  }
  /** Re-syncs the predicted balls with a fresh authoritative snapshot. */
  onSnapshot(snap) {
    while (this.balls.length < snap.balls.length) {
      const s = snap.balls[this.balls.length];
      this.balls.push({ x: s.x, y: s.y, vx: s.vx, vy: s.vy });
      this.corrections.push({ x: 0, y: 0 });
    }
    this.balls.length = snap.balls.length;
    this.corrections.length = snap.balls.length;
    const lead = Math.max(0, this.latencySec);
    for (let i = 0; i < snap.balls.length; i++) {
      const s = snap.balls[i];
      const b = this.balls[i];
      const tx = s.x + s.vx * lead;
      const ty = s.y + s.vy * lead;
      const ex = tx - b.x;
      const ey = ty - b.y;
      const err = Math.hypot(ex, ey);
      this.corrections[i] = err > CORRECTION_THRESHOLD ? { x: ex, y: ey } : { x: 0, y: 0 };
      b.vx = s.vx;
      b.vy = s.vy;
    }
  }
  /** Advances the local ball simulation (called every animation frame). */
  step(dt) {
    if (dt <= 0) return;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      this.collideBall(b);
      const c = this.corrections[i];
      const k = Math.min(1, dt * 1e3 / CORRECTION_MS);
      b.x += c.x * k;
      b.y += c.y * k;
      c.x -= c.x * k;
      c.y -= c.y * k;
    }
  }
  collideBall(b) {
    for (const seg of this.walls) {
      const closest = closestPointOnSegment({ x: b.x, y: b.y }, seg);
      const dx = b.x - closest.x;
      const dy = b.y - closest.y;
      const d = Math.hypot(dx, dy);
      if (d >= this.ballRadius || d === 0) continue;
      const nx = dx / d;
      const ny = dy / d;
      const dotv = b.vx * nx + b.vy * ny;
      if (dotv < 0) {
        b.vx -= 2 * dotv * nx;
        b.vy -= 2 * dotv * ny;
      }
      b.x = closest.x + nx * this.ballRadius;
      b.y = closest.y + ny * this.ballRadius;
    }
  }
  getBalls() {
    return this.balls;
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
  /** Drops all buffered snapshots (e.g. after the arena re-formed). */
  clear() {
    this.snaps = [];
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
};

// frontend/src/renderer.ts
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
    const camAngle = this.myIndex >= 0 ? Math.PI / 2 - faceMidAngle(this.sides, this.myIndex) : 0;
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

// frontend/src/ui.ts
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
function stateLabel(state) {
  return state === "waiting" ? "\u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435" : state === "playing" ? "\u0438\u0433\u0440\u0430" : "\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430";
}
function renderRoomList(rooms2, filter, onPick) {
  const list = $("room-list");
  list.innerHTML = "";
  const f = filter.trim().toLowerCase();
  const shown = rooms2.filter((r) => !f || r.roomID.toLowerCase().includes(f));
  if (shown.length === 0) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = rooms2.length === 0 ? "\u041A\u043E\u043C\u043D\u0430\u0442 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442" : "\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E";
    list.appendChild(li);
    return;
  }
  for (const r of shown) {
    const li = document.createElement("li");
    li.className = "room-row";
    li.tabIndex = 0;
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = r.roomID + (r.hasPassword ? " \u{1F512}" : "");
    const meta = document.createElement("span");
    meta.className = "hint";
    meta.textContent = `${r.players}/${r.maxPlayers} \xB7 ${stateLabel(r.state)}`;
    li.append(name, meta);
    li.addEventListener("click", () => onPick(r.roomID));
    list.appendChild(li);
  }
}
function renderPlayers(container, snap, isHost, onKick) {
  container.innerHTML = "";
  snap.players.forEach((p, i) => {
    const li = document.createElement("li");
    const dot2 = document.createElement("span");
    dot2.className = "dot";
    dot2.style.background = playerColor(i);
    dot2.style.color = playerColor(i);
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = p.name + (p.isHost ? " \u2605" : "") + (!p.isAlive ? " \xB7 \u043D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u0435\u043B\u044C" : "");
    li.append(dot2, name);
    if (isHost && p.id !== snap.you) {
      const kick = document.createElement("button");
      kick.className = "btn btn-sm btn-kick";
      kick.type = "button";
      kick.textContent = "\u0412\u044B\u0433\u043D\u0430\u0442\u044C";
      kick.addEventListener("click", () => onKick(p.id));
      li.appendChild(kick);
    }
    container.appendChild(li);
  });
}
function renderLobby(snap, link, onKick) {
  $("lobby-room-id").textContent = snap.roomID;
  $("lobby-link").value = link;
  const isHost = snap.players.some((p) => p.id === snap.you && p.isHost);
  renderPlayers($("lobby-players"), snap, isHost, onKick);
  $("btn-start").classList.toggle("hidden", !isHost);
  $("lobby-status").textContent = isHost ? "\u0412\u044B \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u044C \u2014 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041D\u0430\u0447\u0430\u0442\u044C \u0438\u0433\u0440\u0443\xBB, \u043A\u043E\u0433\u0434\u0430 \u0432\u0441\u0435 \u0433\u043E\u0442\u043E\u0432\u044B." : "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u0435\u043C...";
}
function renderGameOverPlayers(snap, onKick) {
  const isHost = snap.players.some((p) => p.id === snap.you && p.isHost);
  renderPlayers($("game-over-kick-list"), snap, isHost, onKick);
}
function renderHUD(snap, elapsedSec) {
  const wrap = $("hud-players");
  wrap.innerHTML = "";
  for (const p of snap.players) {
    const item = document.createElement("div");
    item.className = "hud-player" + (p.isAlive ? "" : " dead");
    const dot2 = document.createElement("span");
    dot2.className = "dot";
    dot2.style.background = playerColor(Math.max(0, p.index));
    dot2.style.color = playerColor(Math.max(0, p.index));
    const name = document.createElement("span");
    name.textContent = p.name;
    const lives = document.createElement("span");
    lives.className = "lives";
    lives.textContent = p.isAlive ? "\u2665".repeat(Math.max(0, p.lives)) : "\u2715";
    item.append(dot2, name, lives);
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

// frontend/src/main.ts
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
var currentSides = 0;
var currentMyIndex = -1;
var wasAlive = true;
var playing = false;
var rafId = 0;
var intervalId = null;
var intervalMode = false;
var lastFrameTime = 0;
var lastLoopTick = 0;
var matchStartTime = 0;
var keys = { left: false, right: false };
var rooms = [];
var lastLobbySig = "";
var lastGameOverSig = "";
var gameOverInitDone = false;
function init() {
  const nameInput = $("player-name");
  const saved = localStorage.getItem(NAME_KEY);
  if (saved) nameInput.value = saved;
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam) $("join-room-name").value = roomParam;
  bindCreatePanel();
  bindButtons();
  bindKeys();
  refreshRooms();
  window.setInterval(refreshRooms, 5e3);
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
  const goLives = $("go-lives");
  const goAccel = $("go-accel");
  const goBall = $("go-ball");
  const goBallLabel = () => {
    $("go-ball-val").textContent = Number(goBall.value) === 0 ? "\u0432\u044B\u043A\u043B" : `${goBall.value} \u0441\u0435\u043A`;
  };
  goLives.addEventListener("input", () => {
    $("go-lives-val").textContent = goLives.value;
    sendConfig();
  });
  goAccel.addEventListener("change", sendConfig);
  goBall.addEventListener("input", () => {
    goBallLabel();
    sendConfig();
  });
  goBallLabel();
}
function sendConfig() {
  const lives = Number($("go-lives").value);
  const accel = $("go-accel").checked;
  const ball = Number($("go-ball").value);
  net?.send({ action: "config", lives, ballAccel: accel, addBallTime: ball });
}
function bindButtons() {
  $("btn-create").addEventListener("click", () => {
    $("create-panel").classList.toggle("hidden");
  });
  $("btn-create-go").addEventListener("click", createRoom);
  $("btn-join").addEventListener("click", joinRoom);
  $("btn-refresh-rooms").addEventListener("click", refreshRooms);
  $("room-filter").addEventListener("input", renderRooms);
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
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}
function bindKeys() {
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
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
    if (isTypingTarget(e.target)) return;
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
  const me = latestSnap?.players.find((p) => p.id === meID);
  if (me && !me.isAlive) return;
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
  const name = $("inp-room-name").value.trim();
  const pass = $("inp-room-pass").value;
  const max = Number($("inp-max").value);
  const lives = Number($("inp-lives").value);
  const accel = $("inp-accel").checked;
  const ball = Number($("inp-ball").value);
  if (!name) {
    showMenuError("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043C\u043D\u0430\u0442\u044B");
    return;
  }
  try {
    const res = await fetch("/create-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        password: pass,
        maxPlayers: max,
        livesCount: lives,
        ballAccel: accel,
        addBallTime: ball
      })
    });
    const data = await res.json();
    if (!res.ok) {
      showMenuError(data.error || "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u043A\u043E\u043C\u043D\u0430\u0442\u0443");
      return;
    }
    connect(data.roomID, pass);
  } catch {
    showMenuError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u043A\u043E\u043C\u043D\u0430\u0442\u0443. \u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D?");
  }
}
function joinRoom() {
  const name = $("join-room-name").value.trim();
  const pass = $("join-room-pass").value;
  if (!name) {
    showMenuError("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043C\u043D\u0430\u0442\u044B");
    return;
  }
  connect(name, pass);
}
function connect(roomID, password = "") {
  const name = getPlayerName();
  localStorage.setItem(NAME_KEY, name);
  showMenuError(null);
  net?.close();
  net = new Net(roomID, name, password, {
    onWelcome: (w) => {
      meID = w.you;
    },
    onSnapshot: handleSnapshot,
    onError: (m) => {
      net?.close();
      showScreen("menu");
      showMenuError(m);
      refreshRooms();
    },
    onKicked: () => {
      net?.close();
      showScreen("menu");
      showMenuError("\u0412\u044B \u0431\u044B\u043B\u0438 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u044B \u0438\u0437 \u043A\u043E\u043C\u043D\u0430\u0442\u044B");
      refreshRooms();
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
function kickPlayer(id) {
  net?.send({ action: "kick", target: id });
}
function playersSignature(snap) {
  return snap.players.map((p) => `${p.id}:${p.isHost}:${p.isAlive}`).join("|");
}
async function refreshRooms() {
  try {
    const res = await fetch("/rooms");
    if (!res.ok) return;
    const data = await res.json();
    rooms = data.rooms || [];
    renderRooms();
  } catch {
  }
}
function renderRooms() {
  const filter = $("room-filter").value;
  renderRoomList(rooms, filter, (name) => {
    $("join-room-name").value = name;
    $("join-room-pass").focus();
  });
}
function handleSnapshot(snap) {
  latestSnap = snap;
  buffer.push(snap);
  physics.sync(snap);
  physics.onSnapshot(snap);
  const me = snap.players.find((p) => p.id === snap.you);
  if (snap.state === "waiting") {
    playing = false;
    showScreen("lobby");
    const sig = playersSignature(snap);
    if (sig !== lastLobbySig) {
      lastLobbySig = sig;
      renderLobby(snap, buildInviteLink(snap.roomID), kickPlayer);
    }
  } else if (snap.state === "playing") {
    if (me) {
      serverMyAngle = me.angle;
      serverLastSeq = me.lastSeq ?? 0;
    }
    if (!playing) {
      startPlaying(snap);
    } else {
      if (me && !me.isAlive && wasAlive) {
        showToast("\u0412\u044B \u0432\u044B\u0431\u044B\u043B\u0438 \u2014 \u0442\u0435\u043F\u0435\u0440\u044C \u0432\u044B \u043D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u0435\u043B\u044C");
      }
      if (me) wasAlive = me.isAlive;
      const myIdx = me && me.isAlive ? me.index : -1;
      if (snap.sides !== currentSides || myIdx !== currentMyIndex) {
        buffer.clear();
        buffer.push(snap);
        setupField(snap);
      }
    }
  } else if (snap.state === "ended") {
    showGameOver(snap);
  }
}
function setupField(snap) {
  const me = snap.players.find((p) => p.id === snap.you);
  const myIndex = me && me.isAlive ? me.index : -1;
  if (!renderer) renderer = new GameRenderer($("game-canvas"));
  renderer.resize();
  renderer.setup(snap.sides, snap.radius, snap.chamfer, snap.paddleHalf, snap.ballRadius, myIndex);
  physics.setup(snap.sides, snap.radius, snap.chamfer, snap.ballRadius);
  currentSides = snap.sides;
  currentMyIndex = myIndex;
}
function startPlaying(snap) {
  playing = true;
  wasAlive = true;
  matchStartTime = performance.now();
  gameOverInitDone = false;
  const me = snap.players.find((p) => p.id === snap.you);
  myAngle = me ? me.angle : 0.5;
  serverMyAngle = myAngle;
  $("game-over").classList.add("hidden");
  showScreen("game");
  setupField(snap);
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
    physics.latencySec = latency / 1e3;
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
      balls: physics.getBalls()
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
    renderer.render({
      snap: latestSnap,
      players,
      myAngle,
      balls: physics.getBalls()
    });
  }
  const winner = snap.players.find((p) => p.id === snap.winner);
  let text;
  if (!winner) text = "\u041D\u0438\u0447\u044C\u044F";
  else if (winner.id === meID) text = "\u{1F3C6} \u0412\u044B \u043F\u043E\u0431\u0435\u0434\u0438\u043B\u0438!";
  else text = `\u041F\u043E\u0431\u0435\u0434\u0438\u043B: ${winner.name}`;
  $("game-over-text").textContent = text;
  renderHUD(snap, (performance.now() - matchStartTime) / 1e3);
  const me = snap.players.find((p) => p.id === snap.you);
  const isHost = !!me?.isHost;
  $("btn-restart").classList.toggle("hidden", !isHost);
  $("game-over-config").classList.toggle("hidden", !isHost);
  $("game-over-players").textContent = isHost ? `\u0418\u0433\u0440\u043E\u043A\u043E\u0432 \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0435: ${snap.players.length} \u2014 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u0442\u0435 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u0418\u0433\u0440\u0430\u0442\u044C \u0441\u043D\u043E\u0432\u0430\xBB` : "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u0435\u043C...";
  if (!gameOverInitDone) {
    gameOverInitDone = true;
    const lives = snap.lives ?? 3;
    const accel = snap.ballAccel ?? true;
    const ball = snap.addBallTime ?? 15;
    $("go-lives").value = String(lives);
    $("go-lives-val").textContent = String(lives);
    $("go-accel").checked = accel;
    $("go-ball").value = String(ball);
    $("go-ball-val").textContent = ball === 0 ? "\u0432\u044B\u043A\u043B" : `${ball} \u0441\u0435\u043A`;
  }
  const sig = playersSignature(snap);
  if (sig !== lastGameOverSig) {
    lastGameOverSig = sig;
    renderGameOverPlayers(snap, kickPlayer);
  }
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
  lastLobbySig = "";
  lastGameOverSig = "";
  gameOverInitDone = false;
  refreshRooms();
  showScreen("menu");
}
function buildInviteLink(roomID) {
  return `${location.origin}${location.pathname}?room=${roomID}`;
}
init();
