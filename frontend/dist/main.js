// ../frontend/src/net.ts
var Net = class {
  constructor(roomID, playerName, password, handlers) {
    this.roomID = roomID;
    this.playerName = playerName;
    this.password = password;
    this.handlers = handlers;
    this.ws = null;
    this.pingTimer = null;
    this.latencyMs = 20;
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
          this.latencyMs = Math.max(1, Math.min(250, rtt / 2));
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

// ../frontend/src/physics.ts
var RENDER_DELAY_MS = 80;
var CURVE_RATE = 3.5;
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
      this.balls.push({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, curve: s.cv ?? 0 });
      this.corrections.push({ x: 0, y: 0 });
    }
    this.balls.length = snap.balls.length;
    this.corrections.length = snap.balls.length;
    const lead = Math.max(0, this.latencySec);
    for (let i = 0; i < snap.balls.length; i++) {
      const s = snap.balls[i];
      const b = this.balls[i];
      b.curve = s.cv ?? 0;
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
      if (b.curve > 0) {
        const ang = CURVE_RATE * dt;
        const c2 = Math.cos(ang);
        const s = Math.sin(ang);
        const nx = b.vx * c2 - b.vy * s;
        b.vy = b.vx * s + b.vy * c2;
        b.vx = nx;
      }
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

// ../frontend/src/items.ts
var ITEMS = [
  { key: "fire", name: "\u0413\u043E\u0440\u044F\u0449\u0438\u0439 \u043C\u044F\u0447", desc: "+50% \u043A \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u0438 \u043C\u044F\u0447\u0430", color: "#ffb020", dark: "#ff3d00" },
  { key: "flash", name: "\u041E\u0441\u043B\u0435\u043F\u043B\u0435\u043D\u0438\u0435", desc: "\u0412\u0441\u043F\u044B\u0448\u043A\u0430 \u043E\u0441\u043B\u0435\u043F\u043B\u044F\u0435\u0442 \u0432\u0441\u0435\u0445 \u0441\u043E\u043F\u0435\u0440\u043D\u0438\u043A\u043E\u0432", color: "#ffffff", dark: "#ffe9a8" },
  { key: "curve", name: "\u041A\u0440\u0443\u0447\u0451\u043D\u044B\u0439", desc: "\u041C\u044F\u0447 \u043B\u0435\u0442\u0438\u0442 \u043F\u043E \u0434\u0443\u0433\u0435", color: "#4dd0ff", dark: "#0b6fff" },
  { key: "shield", name: "\u0417\u0430\u0449\u0438\u0442\u0430", desc: "\u0412\u043E\u0440\u043E\u0442\u0430 \u043D\u0435\u043F\u0440\u043E\u0431\u0438\u0432\u0430\u0435\u043C\u044B 8 \u0441\u0435\u043A", color: "#e8eef2", dark: "#8fa6b5" },
  { key: "freeze", name: "\u0417\u0430\u043C\u043E\u0440\u043E\u0437\u043A\u0430", desc: "\u041C\u043E\u0440\u043E\u0437\u0438\u0442 \u0441\u043B\u0443\u0447\u0430\u0439\u043D\u043E\u0433\u043E \u0441\u043E\u043F\u0435\u0440\u043D\u0438\u043A\u0430", color: "#aee6ff", dark: "#4fc3f7" },
  { key: "fake", name: "\u041E\u0431\u043C\u0430\u043D\u043A\u0430", desc: "\u0414\u0432\u0430 \u0437\u0435\u0440\u043A\u0430\u043B\u044C\u043D\u044B\u0445 \u043C\u044F\u0447\u0430", color: "#d18bff", dark: "#8e24aa" },
  { key: "sticky", name: "\u041B\u0438\u043F\u0443\u0447\u043A\u0430", desc: "\u041C\u044F\u0447 \u043B\u0438\u043F\u043D\u0435\u0442 \u043A \u043F\u043E\u0432\u0435\u0440\u0445\u043D\u043E\u0441\u0442\u044F\u043C", color: "#a9ff4d", dark: "#3fa72f" },
  { key: "tether", name: "\u0421\u0432\u044F\u0437\u044B\u0432\u0430\u043D\u0438\u0435", desc: "\u041F\u0440\u0438\u0432\u044F\u0437\u044B\u0432\u0430\u0435\u0442 \u043C\u044F\u0447 \u043A \u043A\u0430\u0440\u0435\u0442\u043A\u0435", color: "#d8a06a", dark: "#8a5a2b" },
  { key: "shake", name: "\u0420\u0435\u0436\u0438\u043C \u0442\u0440\u044F\u0441\u043A\u0438", desc: "\u0422\u0440\u044F\u0441\u043A\u0430 \u044D\u043A\u0440\u0430\u043D\u0430 \u0443 \u0432\u0441\u0435\u0445", color: "#ff8a4d", dark: "#c0392b" }
];
var BY_KEY = /* @__PURE__ */ new Map();
for (const it of ITEMS) BY_KEY.set(it.key, it);
function itemDef(key) {
  if (!key) return null;
  return BY_KEY.get(key) || null;
}
function drawItemIcon(ctx, key, cx, cy, r) {
  const def = itemDef(key);
  if (!def) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = def.color;
  ctx.shadowBlur = r * 0.8;
  ctx.lineJoin = "round";
  switch (key) {
    case "fire":
      flame(ctx, r);
      break;
    case "flash":
      burst(ctx, r);
      break;
    case "curve":
      swirl(ctx, r);
      break;
    case "shield":
      shieldIcon(ctx, r);
      break;
    case "freeze":
      snowflake(ctx, r);
      break;
    case "fake":
      doubleBall(ctx, r);
      break;
    case "sticky":
      droplet(ctx, r);
      break;
    case "tether":
      ropeKnot(ctx, r);
      break;
    case "shake":
      volcano(ctx, r);
      break;
  }
  ctx.restore();
}
function flame(ctx, r) {
  const g = ctx.createLinearGradient(0, r, 0, -r);
  g.addColorStop(0, "#ff3d00");
  g.addColorStop(0.55, "#ff9100");
  g.addColorStop(1, "#ffea00");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.bezierCurveTo(r * 0.8, -r * 0.15, r * 0.65, r * 0.55, 0, r);
  ctx.bezierCurveTo(-r * 0.65, r * 0.55, -r * 0.8, -r * 0.15, 0, -r);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.45);
  ctx.bezierCurveTo(r * 0.35, -r * 0.05, r * 0.22, r * 0.3, 0, r * 0.45);
  ctx.bezierCurveTo(-r * 0.22, r * 0.3, -r * 0.35, -r * 0.05, 0, -r * 0.45);
  ctx.fill();
}
function burst(ctx, r) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffe9a8";
  ctx.lineWidth = r * 0.14;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
    ctx.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
}
function swirl(ctx, r) {
  ctx.strokeStyle = "#0b6fff";
  ctx.lineWidth = r * 0.22;
  ctx.beginPath();
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    const a = t * Math.PI * 3.4;
    const rad = r * (0.25 + 0.75 * t);
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#4dd0ff";
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
}
function shieldIcon(ctx, r) {
  ctx.fillStyle = "#dfe7ec";
  ctx.strokeStyle = "#8fa6b5";
  ctx.lineWidth = r * 0.16;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(r, -r * 0.55, r, 0);
  ctx.quadraticCurveTo(r, r * 0.6, 0, r);
  ctx.quadraticCurveTo(-r, r * 0.6, -r, 0);
  ctx.quadraticCurveTo(-r, -r * 0.55, 0, -r);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "#6e8796";
  ctx.lineWidth = r * 0.18;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.7);
  ctx.lineTo(0, r * 0.75);
  ctx.moveTo(-r * 0.62, 0);
  ctx.lineTo(r * 0.62, 0);
  ctx.stroke();
}
function snowflake(ctx, r) {
  ctx.strokeStyle = "#7fd8ff";
  ctx.lineWidth = r * 0.18;
  ctx.lineCap = "round";
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(dx * r * 0.2, dy * r * 0.2);
    ctx.lineTo(dx * r, dy * r);
    ctx.stroke();
    const bx = dx * r * 0.7;
    const by = dy * r * 0.7;
    ctx.beginPath();
    ctx.moveTo(bx - dy * r * 0.22, by + dx * r * 0.22);
    ctx.lineTo(bx + dy * r * 0.22, by - dx * r * 0.22);
    ctx.stroke();
  }
  ctx.fillStyle = "#d7f2ff";
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
}
function doubleBall(ctx, r) {
  ctx.fillStyle = "#b06bff";
  ctx.strokeStyle = "#d18bff";
  ctx.lineWidth = r * 0.1;
  ctx.beginPath();
  ctx.arc(-r * 0.5, 0, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(r * 0.5, 0, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(r * 0.5, -r * 0.15, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}
function droplet(ctx, r) {
  const g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, "#c6ff6b");
  g.addColorStop(1, "#2e9e35");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.bezierCurveTo(r * 0.95, r * 0.2, r * 0.6, r, 0, r);
  ctx.bezierCurveTo(-r * 0.6, r, -r * 0.95, r * 0.2, 0, -r);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.beginPath();
  ctx.arc(-r * 0.3, r * 0.25, r * 0.24, 0, Math.PI * 2);
  ctx.fill();
}
function ropeKnot(ctx, r) {
  ctx.strokeStyle = "#8a5a2b";
  ctx.lineWidth = r * 0.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-r, -r * 0.6);
  ctx.quadraticCurveTo(0, r * 0.1, r, -r * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-r, r * 0.6);
  ctx.quadraticCurveTo(0, -r * 0.1, r, r * 0.6);
  ctx.stroke();
  ctx.strokeStyle = "#d8a06a";
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
  ctx.stroke();
}
function volcano(ctx, r) {
  ctx.fillStyle = "#7b4a2b";
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.45);
  ctx.lineTo(r * 0.85, r);
  ctx.lineTo(-r * 0.85, r);
  ctx.closePath();
  ctx.fill();
  const g = ctx.createLinearGradient(0, -r * 0.5, 0, r);
  g.addColorStop(0, "#ffcc33");
  g.addColorStop(1, "#e6482f");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.45);
  ctx.quadraticCurveTo(r * 0.2, r * 0.2, 0, r * 0.5);
  ctx.quadraticCurveTo(-r * 0.2, r * 0.2, 0, -r * 0.45);
  ctx.fill();
}

// ../frontend/src/renderer.ts
var PALETTE = ["#00f0ff", "#ff3df0", "#ffe600", "#39ff6a", "#ff7a00", "#9d6bff"];
function playerColor(index) {
  return PALETTE[(index % PALETTE.length + PALETTE.length) % PALETTE.length];
}
function paddleFxKey(p) {
  const fx = p.fx;
  if (fx && (fx.fire ?? 0) > 0) return "fire";
  if (fx && (fx.sticky ?? 0) > 0) return "sticky";
  if (fx && (fx.shield ?? 0) > 0) return "shield";
  if (p.use && (p.useT ?? 0) > 0) return p.use;
  if (p.arm) return p.arm;
  return null;
}
function ballColor(fx) {
  if (!fx) return "#00f0ff";
  if (fx.fire) return "#ffb020";
  if (fx.sticky) return "#7bff5a";
  if ((fx.cv ?? 0) > 0) return "#4dd0ff";
  if (fx.fake || fx.tether) return "#c084fc";
  return "#00f0ff";
}
var GameRenderer = class {
  // key -> first-seen ms, pop anims
  constructor(canvas) {
    this.canvas = canvas;
    this.walls = [];
    this.radius = 300;
    this.chamfer = 40;
    this.paddleHalf = 0.11;
    this.ballRadius = 9;
    this.sides = 6;
    this.myIndex = 0;
    this.fxSeen = /* @__PURE__ */ new Map();
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
  meFx(state) {
    const me = state.snap.players.find((p) => p.id === state.snap.you);
    return me ? me.fx : void 0;
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
    let sx = 0;
    let sy = 0;
    const shakeSec = this.meFx(state)?.shake ?? 0;
    if (shakeSec > 0) {
      const t = performance.now() / 1e3;
      const amp = Math.min(10 + shakeSec * 4, 26);
      sx = Math.sin(t * 47.3) * amp;
      sy = Math.cos(t * 53.7) * amp;
    }
    ctx.save();
    ctx.translate(cx + sx, cy + sy);
    ctx.rotate(camAngle);
    ctx.scale(scale, scale);
    this.drawRing();
    this.drawArena(state);
    this.drawRopes(state);
    this.drawPlayerFx(state);
    this.drawPaddles(state);
    this.drawBalls(state);
    ctx.restore();
    this.drawScreenFx(state, sx, sy);
    if (state.snap.state === "playing" && state.balls.length === 0 && state.snap.respawnIn && state.snap.respawnIn > 0) {
      this.drawCountdown(state.snap.respawnIn);
    }
  }
  drawScreenFx(state, sx, sy) {
    const ctx = this.ctx;
    const fx = this.meFx(state);
    const blind = fx?.blind ?? 0;
    if (blind > 0) {
      const alpha = blind > 1.6 ? 0.94 : Math.max(0, blind * 0.55);
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }
    if ((fx?.shake ?? 0) > 0 && (sx !== 0 || sy !== 0)) {
      ctx.save();
      ctx.strokeStyle = "rgba(180,80,40,0.25)";
      ctx.lineWidth = Math.max(this.canvas.width, this.canvas.height) * 0.16;
      ctx.shadowColor = "rgba(120,40,20,0.6)";
      ctx.shadowBlur = 30;
      ctx.strokeRect(-this.canvas.width * 0.2, -this.canvas.height * 0.2, this.canvas.width * 1.4, this.canvas.height * 1.4);
      ctx.restore();
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
        } else if ((player.fx?.shield ?? 0) > 0) {
          ctx.shadowColor = "#e8eef2";
          ctx.strokeStyle = "rgba(224,236,244,0.95)";
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
  /** Rope of the tether item: ball <-> anchor paddle centre, slack curves sag. */
  drawRopes(state) {
    const ctx = this.ctx;
    const snapBalls = state.snap.balls;
    state.balls.forEach((b, i) => {
      const sb = snapBalls && snapBalls[i];
      if (!sb || !sb.tether || !sb.tt || (sb.th ?? 0) < 1) return;
      const anchor = state.players.find((p) => p.id === sb.tt);
      if (!anchor || anchor.index < 0) return;
      const seg = this.walls[2 * anchor.index];
      if (!seg) return;
      const faceLen = len(sub(seg.b, seg.a));
      const ropeLen = 4 * faceLen * this.paddleHalf;
      const ac = add(seg.a, mul(sub(seg.b, seg.a), anchor.angle));
      const from = { x: b.x, y: b.y };
      const dx = from.x - ac.x;
      const dy = from.y - ac.y;
      const d = Math.hypot(dx, dy);
      const taut = d >= ropeLen;
      ctx.save();
      ctx.lineCap = "round";
      ctx.shadowColor = "#8a5a2b";
      ctx.shadowBlur = 6;
      ctx.strokeStyle = "#b08050";
      ctx.lineWidth = Math.max(2.5, faceLen * 0.018);
      ctx.beginPath();
      if (taut) {
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(ac.x, ac.y);
      } else {
        const sag = Math.min(1, 1 - d / ropeLen) * ropeLen * 0.5;
        const mx = (from.x + ac.x) / 2;
        const my = (from.y + ac.y) / 2;
        const n = d > 0 ? { x: -dy / d, y: dx / d } : { x: 0, y: 1 };
        const cpx = mx + n.x * sag;
        const cpy = my + n.y * sag;
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(cpx, cpy, ac.x, ac.y);
      }
      ctx.stroke();
      ctx.restore();
    });
  }
  /** Item icon + pop animation behind a paddle when an ability is active/armed. */
  drawPlayerFx(state) {
    const ctx = this.ctx;
    const faceLen = 2 * this.radius * Math.sin(Math.PI / this.sides);
    const byId = /* @__PURE__ */ new Map();
    for (const sp of state.snap.players) byId.set(sp.id, sp);
    const now = performance.now();
    for (const p of state.players) {
      if (!p.isAlive || p.index < 0) continue;
      const sp = byId.get(p.id);
      if (!sp) continue;
      const key = paddleFxKey(sp);
      if (!key) continue;
      const seg = this.walls[2 * p.index];
      if (!seg) continue;
      const mid = mul(add(seg.a, seg.b), 0.5);
      const n = norm(mid);
      const iconR = faceLen * 0.11;
      const off = faceLen * 0.22 + this.ballRadius * 2;
      const bx = mid.x + n.x * off;
      const by = mid.y + n.y * off;
      const seenKey = p.id + ":" + key;
      let first = this.fxSeen.get(seenKey);
      if (first === void 0) {
        first = now;
        this.fxSeen.set(seenKey, now);
      }
      const age = now - first;
      const pop = 1 + Math.max(0, 0.6 * Math.exp(-age * 6e-3));
      ctx.save();
      ctx.globalAlpha = Math.min(1, 0.75 + age * 0.01);
      drawItemIcon(ctx, key, bx, by, iconR * pop);
      if (age < 600) {
        ctx.globalAlpha = 1 - age / 600;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, iconR * (1.4 + age / 600 * 1.6), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (this.fxSeen.size > 200) {
      for (const [k, t] of this.fxSeen) {
        if (now - t > 3e3) this.fxSeen.delete(k);
      }
    }
  }
  drawPaddles(state) {
    const ctx = this.ctx;
    const faceLen = 2 * this.radius * Math.sin(Math.PI / this.sides);
    const halfLen = faceLen * this.paddleHalf;
    const byId = /* @__PURE__ */ new Map();
    for (const sp of state.snap.players) byId.set(sp.id, sp);
    for (const p of state.players) {
      if (!p.isAlive) continue;
      const seg = this.walls[2 * p.index];
      if (!seg) continue;
      const angle = p.id === state.snap.you ? state.myAngle : p.angle;
      const dir = norm(sub(seg.b, seg.a));
      const center = add(seg.a, mul(sub(seg.b, seg.a), angle));
      const a = add(center, mul(dir, -halfLen));
      const b = add(center, mul(dir, halfLen));
      let col = playerColor(p.index);
      const sp = byId.get(p.id);
      const frozen = (sp?.fx?.frozen ?? 0) > 0;
      if (frozen) col = "#aee6ff";
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
      ctx.strokeStyle = frozen ? "#eafcff" : "#ffffff";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (frozen) {
        ctx.shadowBlur = 12;
        ctx.strokeStyle = "#7fd8ff";
        ctx.lineWidth = 2.5;
        const t = performance.now() / 1e3;
        const wob = Math.sin(t * 8 + p.index * 2) * 2;
        for (let s = -1; s <= 1; s++) {
          const mx = center.x + dir.x * halfLen * s;
          const my = center.y + dir.y * halfLen * s;
          const tipx = mx + wob;
          const tipy = my - (this.ballRadius * 1.6 + (s + 1) * 3);
          ctx.beginPath();
          ctx.moveTo(mx, my - 6);
          ctx.lineTo(tipx, tipy);
          ctx.moveTo(mx, my - 6);
          ctx.lineTo(mx + s * 4, my - 14);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
  drawBalls(state) {
    const ctx = this.ctx;
    const snapBalls = state.snap.balls;
    state.balls.forEach((b, i) => {
      const fx = snapBalls && snapBalls[i];
      const color = ballColor(fx);
      const glowR = this.ballRadius * (fx?.fire ? 2.4 : 1.7);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = fx?.fire ? 22 : 12;
      const halo = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, glowR);
      halo.addColorStop(0, "rgba(255,255,255,0.95)");
      halo.addColorStop(0.45, hexA(color, 0.5));
      halo.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fx?.fake ? 0.75 : 1;
      ctx.fillStyle = fx?.fire ? "#fff1c4" : fx?.sticky ? "#eaffd8" : "#ffffff";
      ctx.beginPath();
      ctx.arc(b.x, b.y, this.ballRadius, 0, Math.PI * 2);
      ctx.fill();
      if (fx?.fire) {
        ctx.fillStyle = "#ff9f1a";
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 0.45, 0, Math.PI * 2);
        ctx.fill();
      } else if (fx?.sticky) {
        ctx.strokeStyle = "#3fa72f";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 1.15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if ((fx?.cv ?? 0) > 0) {
        ctx.strokeStyle = "#4dd0ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 0.6, Math.PI * 0.2, Math.PI * 1.4);
        ctx.stroke();
      } else if (fx?.fake || fx?.tether) {
        ctx.strokeStyle = "#c084fc";
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 1.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if ((fx?.stuck ?? 0) > 0) {
        ctx.strokeStyle = "rgba(127,255,90,0.8)";
        ctx.lineWidth = 3;
        const t = performance.now() / 1e3;
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * (1.25 + Math.sin(t * 6) * 0.08), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    });
  }
};
function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const bl = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${bl},${a})`;
}

// ../frontend/src/ui.ts
function $(id) {
  return document.getElementById(id);
}
var SCREENS = ["menu", "create", "join", "lobby", "game"];
function showScreen(name) {
  SCREENS.forEach((s) => {
    $("screen-" + s).classList.toggle("active", s === name);
  });
}
function showMenuError(msg) {
  const box = $("menu-error");
  box.textContent = msg ?? "";
  box.classList.toggle("hidden", !msg);
}
function showFormError(form, msg) {
  const box = $(form + "-error");
  box.textContent = msg ?? "";
  box.classList.toggle("hidden", !msg);
}
function stateLabel(state) {
  return state === "waiting" ? "\u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435" : state === "playing" ? "\u0438\u0433\u0440\u0430" : "\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430";
}
function renderRoomList(rooms2, filter, stateFilter, onJoin) {
  const list = $("room-list");
  list.innerHTML = "";
  const f = filter.trim().toLowerCase();
  const shown = rooms2.filter((r) => {
    if (f && !r.roomID.toLowerCase().includes(f)) return false;
    if (stateFilter !== "all" && r.state !== stateFilter) return false;
    return true;
  });
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
    const info = document.createElement("div");
    info.className = "room-info";
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = r.roomID + (r.hasPassword ? " \u{1F512}" : "");
    const meta = document.createElement("span");
    meta.className = "hint";
    meta.textContent = `${r.players}/${r.maxPlayers} \xB7 ${stateLabel(r.state)}`;
    info.append(name, meta);
    const join = document.createElement("button");
    join.className = "btn btn-sm btn-join";
    join.type = "button";
    join.textContent = "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F";
    join.addEventListener("click", (e) => {
      e.stopPropagation();
      onJoin(r.roomID);
    });
    li.append(info, join);
    li.addEventListener("click", () => onJoin(r.roomID));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onJoin(r.roomID);
      }
    });
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
function updateItemSlot(snap) {
  const slot = $("item-slot");
  const cv = $("item-slot-canvas");
  const hint = $("item-slot-hint");
  slot.classList.toggle("hidden", !snap.items);
  if (!snap.items) return;
  const me = snap.players.find((p) => p.id === snap.you);
  const key = me && me.isAlive ? me.item || "" : "";
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (key) {
      drawItemIcon(ctx, key, cv.width / 2, cv.height / 2, cv.width * 0.34);
    }
  }
  const def = itemDef(key);
  hint.textContent = key ? def ? def.name : "\u041F\u0440\u0435\u0434\u043C\u0435\u0442" : "\u2014";
  hint.classList.toggle("hidden", !key);
  if (key) slot.classList.add("flash");
  else slot.classList.remove("flash");
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
var joinRoomID = "";
var connContext = "menu";
var myName = localStorage.getItem(NAME_KEY) || "";
function init() {
  bindCreatePanel();
  bindButtons();
  bindKeys();
  refreshRooms();
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam) {
    openJoin(roomParam);
  } else {
    showScreen("menu");
  }
  window.setInterval(refreshRooms, 5e3);
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
  const goItems = $("go-items");
  const goBallLabel = () => {
    $("go-ball-val").textContent = Number(goBall.value) === 0 ? "\u0432\u044B\u043A\u043B" : `${goBall.value} \u0441\u0435\u043A`;
  };
  goLives.addEventListener("input", () => {
    $("go-lives-val").textContent = goLives.value;
    sendConfig();
  });
  goAccel.addEventListener("change", sendConfig);
  goItems.addEventListener("change", sendConfig);
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
  const items = $("go-items").checked;
  net?.send({ action: "config", lives, ballAccel: accel, addBallTime: ball, items });
}
function bindButtons() {
  $("btn-create").addEventListener("click", openCreate);
  $("btn-refresh-rooms").addEventListener("click", refreshRooms);
  $("room-filter").addEventListener("input", renderRooms);
  $("room-state-filter").addEventListener("change", renderRooms);
  $("btn-create-go").addEventListener("click", createRoom);
  $("btn-create-back").addEventListener("click", backToMenu);
  $("btn-join").addEventListener("click", joinRoom);
  $("btn-join-back").addEventListener("click", backToMenu);
  $("join-pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom();
  });
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
  $("btn-lobby-back").addEventListener("click", leaveToMenu);
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
      case "Space":
        e.preventDefault();
        useItem();
        break;
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
    net?.send({ action: "move", dir: dir * screenDir, seq: inputSeq, lag: net.getLatency() });
  }
}
function useItem() {
  if (!playing) return;
  const me = latestSnap?.players.find((p) => p.id === meID);
  if (me && me.isAlive && me.item) {
    net?.send({ action: "use_item" });
  }
}
function captureName(form) {
  const input = $(form === "create" ? "create-name" : "join-name");
  const name = input.value.trim() || "Player";
  myName = name;
  localStorage.setItem(NAME_KEY, name);
  return name;
}
function openCreate() {
  $("create-name").value = myName;
  showFormError("create", null);
  showScreen("create");
}
function openJoin(roomID) {
  joinRoomID = roomID;
  $("join-room-label").textContent = roomID;
  $("join-name").value = myName;
  $("join-pass").value = "";
  showFormError("join", null);
  showScreen("join");
  $("join-name").focus();
}
function backToMenu() {
  joinRoomID = "";
  showFormError("create", null);
  showFormError("join", null);
  showMenuError(null);
  showScreen("menu");
  refreshRooms();
}
function showGlobalError(msg) {
  showFormError("create", null);
  showFormError("join", null);
  showMenuError(msg);
  showScreen("menu");
  refreshRooms();
}
async function createRoom() {
  const playerName = captureName("create");
  const name = $("inp-room-name").value.trim();
  const pass = $("inp-room-pass").value;
  const max = Number($("inp-max").value);
  const lives = Number($("inp-lives").value);
  const accel = $("inp-accel").checked;
  const ball = Number($("inp-ball").value);
  const items = $("inp-items").checked;
  if (!name) {
    showFormError("create", "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043C\u043D\u0430\u0442\u044B");
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
        addBallTime: ball,
        items
      })
    });
    const data = await res.json();
    if (!res.ok) {
      showFormError("create", data.error || "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u043A\u043E\u043C\u043D\u0430\u0442\u0443");
      return;
    }
    connContext = "create";
    connect(data.roomID, pass, playerName);
  } catch {
    showFormError("create", "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u043A\u043E\u043C\u043D\u0430\u0442\u0443. \u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D?");
  }
}
function joinRoom() {
  const playerName = captureName("join");
  const pass = $("join-pass").value;
  if (!joinRoomID) {
    showFormError("join", "\u041D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D\u0430 \u043A\u043E\u043C\u043D\u0430\u0442\u0430");
    return;
  }
  connContext = "join";
  connect(joinRoomID, pass, playerName);
}
function connect(roomID, password, name) {
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
      if (connContext === "create") {
        showFormError("create", m);
        showScreen("create");
      } else {
        showFormError("join", m);
        showScreen("join");
      }
      refreshRooms();
    },
    onKicked: () => {
      net?.close();
      if (playing) stopLoop();
      showGlobalError("\u0412\u044B \u0431\u044B\u043B\u0438 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u044B \u0438\u0437 \u043A\u043E\u043C\u043D\u0430\u0442\u044B");
    },
    onClose: () => {
      if (playing) stopLoop();
      showGlobalError("\u0421\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u043C \u043F\u043E\u0442\u0435\u0440\u044F\u043D\u043E");
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
  if (!$("screen-menu").classList.contains("active")) return;
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
  const stateFilter = $("room-state-filter").value;
  renderRoomList(rooms, filter, stateFilter, openJoin);
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
    updateItemSlot(snap);
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
  const speed = (latestSnap.paddleSpeed || 380) * ((me.fx?.frozen ?? 0) > 0 ? 0.5 : 1);
  const half = latestSnap.paddleHalf;
  if (dir !== 0) {
    myAngle += dir * screenDir * (speed / faceLen) * dt;
    myAngle = Math.max(half, Math.min(1 - half, myAngle));
  } else if (inputSeq <= serverLastSeq) {
    const tickTravel = speed / faceLen / 60;
    const deadZone = tickTravel * 2;
    const err = serverMyAngle - myAngle;
    if (Math.abs(err) > deadZone) {
      myAngle += err * Math.min(1, dt / 0.15);
    }
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
    const items = snap.items ?? false;
    $("go-lives").value = String(lives);
    $("go-lives-val").textContent = String(lives);
    $("go-accel").checked = accel;
    $("go-ball").value = String(ball);
    $("go-ball-val").textContent = ball === 0 ? "\u0432\u044B\u043A\u043B" : `${ball} \u0441\u0435\u043A`;
    $("go-items").checked = items;
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
  backToMenu();
}
function buildInviteLink(roomID) {
  return `${location.origin}${location.pathname}?room=${roomID}`;
}
init();
