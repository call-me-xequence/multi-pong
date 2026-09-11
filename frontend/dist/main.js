// src/net.ts
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
        case "sfx":
          this.handlers.onSfx(m.events);
          break;
        case "error":
          this.handlers.onError(m.message);
          break;
        case "pong": {
          const rtt = performance.now() - m.c;
          this.latencyMs = Math.max(1, Math.min(250, rtt / 2));
          this.handlers.onLatency?.(this.latencyMs);
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
    }, 1500);
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

// src/physics.ts
var MIN_RENDER_DELAY_MS = 40;
var MAX_RENDER_DELAY_MS = 300;
var BASE_RENDER_DELAY_MS = 80;
var SNAPSHOT_INTERVAL_MS = 1e3 / 64;
var JITTER_K = 2;
var MAX_BALL_EXTRAP_MS = 120;
var NetClock = class {
  constructor() {
    this.timeBase = false;
    this.refServerT = 0;
    this.refClientNow = 0;
    this.delayMs = BASE_RENDER_DELAY_MS;
    // One-way latency and its mean deviation, EWMA-smoothed from ping RTTs.
    this.latencyMs = 30;
    this.rttJitterMs = 0;
    // Snapshot inter-arrival statistics (so bursts adapt the buffer immediately).
    this.lastArrivalAt = 0;
    this.arrivalJitterMs = 0;
    this.haveArrival = false;
  }
  /** Establishes the client<->server clock mapping (idempotent). */
  sync(snap) {
    if (!this.timeBase) {
      this.refServerT = snap.t;
      this.refClientNow = performance.now();
      this.timeBase = true;
    }
  }
  /** Observe a snapshot arrival; tracks inter-arrival jitter and re-sizes. */
  observe(snap) {
    const now = performance.now();
    this.sync(snap);
    if (this.haveArrival) {
      const dev = Math.abs(now - this.lastArrivalAt - SNAPSHOT_INTERVAL_MS);
      this.arrivalJitterMs = this.arrivalJitterMs * 0.9 + dev * 0.1;
    } else {
      this.arrivalJitterMs = 0;
    }
    this.haveArrival = true;
    this.lastArrivalAt = now;
    this.recomputeDelay();
  }
  /** Feed a one-way latency estimate (rtt/2) measured by a ping. */
  updateRtt(oneWayMs) {
    oneWayMs = Math.max(1, Math.min(250, oneWayMs));
    const dev = Math.abs(oneWayMs - this.latencyMs);
    this.latencyMs = this.latencyMs * 0.8 + oneWayMs * 0.2;
    this.rttJitterMs = this.rttJitterMs * 0.8 + dev * 0.2;
    this.recomputeDelay();
  }
  /** Buffer = latency + nominal snapshot cadence + k * worst jitter. */
  recomputeDelay() {
    const jitter = Math.max(this.rttJitterMs, this.arrivalJitterMs);
    const want = this.latencyMs + SNAPSHOT_INTERVAL_MS * 2 + JITTER_K * jitter;
    this.delayMs = Math.max(MIN_RENDER_DELAY_MS, Math.min(MAX_RENDER_DELAY_MS, want));
  }
  /** Current interpolation delay, ms (read-only). */
  get delay() {
    return this.delayMs;
  }
  /** Server time the frame should render at (interpolation target). */
  get renderTime() {
    if (!this.timeBase) return 0;
    return this.refServerT + (performance.now() - this.refClientNow) - this.delayMs;
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
  /**
   * Returns balls interpolated to the given server time, or extrapolated from
   * velocity when the render time is ahead of the newest snapshot (a late
   * arrival). This keeps the ball moving smoothly through jitter spikes instead
   * of freezing at the last known position.
   */
  ballsAt(renderTime) {
    const n = this.snaps.length;
    if (n === 0) return null;
    let i = 0;
    while (i < n - 1 && this.snaps[i + 1].t <= renderTime) i++;
    const a = this.snaps[i];
    const b = i + 1 < n ? this.snaps[i + 1] : null;
    if (b) {
      const span = b.t - a.t || 1;
      const f = Math.max(0, Math.min(1, (renderTime - a.t) / span));
      const cnt = Math.max(a.balls.length, b.balls.length);
      const out = [];
      for (let k = 0; k < cnt; k++) {
        const ba = a.balls[k];
        const bb = b.balls[k];
        if (ba && bb) {
          out.push({
            ...bb,
            x: ba.x + (bb.x - ba.x) * f,
            y: ba.y + (bb.y - ba.y) * f
          });
        } else if (bb) {
          out.push(bb);
        }
      }
      return out;
    }
    const dtSec = Math.max(0, Math.min(MAX_BALL_EXTRAP_MS, renderTime - a.t)) / 1e3;
    return a.balls.map(
      (bb) => dtSec > 0 ? { ...bb, x: bb.x + bb.vx * dtSec, y: bb.y + bb.vy * dtSec } : bb
    );
  }
};

// src/geometry.ts
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

// src/items.ts
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
  const halo = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.35);
  halo.addColorStop(0, hexA(def.color, 0.5));
  halo.addColorStop(0.6, hexA(def.color, 0.14));
  halo.addColorStop(1, hexA(def.color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
  ctx.fill();
  const chip = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.05, 0, 0, r);
  chip.addColorStop(0, "rgba(22,32,56,0.96)");
  chip.addColorStop(0.55, "rgba(11,17,32,0.97)");
  chip.addColorStop(1, "rgba(4,7,15,0.98)");
  ctx.fillStyle = chip;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.98, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = def.color;
  ctx.shadowBlur = r * 0.7;
  ctx.strokeStyle = def.color;
  ctx.lineWidth = r * 0.07;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexA("#ffffff", 0.35);
  ctx.lineWidth = r * 0.025;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.9, Math.PI * 1.05, Math.PI * 2.05);
  ctx.stroke();
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
function hexA(hex, alpha) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  const rr = n >> 16 & 255;
  const gg = n >> 8 & 255;
  const bb = n & 255;
  return `rgba(${rr},${gg},${bb},${alpha})`;
}
function specular(ctx, x, y, rx, ry, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const g = ctx.createRadialGradient(-rx * 0.4, -ry * 0.5, 0, 0, 0, Math.max(rx, ry) * 1.5);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function flame(ctx, r) {
  const fg = ctx.createLinearGradient(0, -r, 0, r * 0.5);
  fg.addColorStop(0, "#fff3b0");
  fg.addColorStop(0.45, "#ffc93d");
  fg.addColorStop(1, "#ff6a00");
  ctx.fillStyle = fg;
  ctx.shadowColor = "#ff8a00";
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.85);
  ctx.bezierCurveTo(r * 0.34, -r * 0.45, r * 0.44, -r * 0.12, r * 0.2, r * 0.16);
  ctx.bezierCurveTo(-r * 0.44, -r * 0.1, -r * 0.34, -r * 0.45, 0, -r * 0.85);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.56);
  ctx.bezierCurveTo(r * 0.18, -r * 0.32, r * 0.2, -r * 0.12, r * 0.08, r * 0.05);
  ctx.bezierCurveTo(-r * 0.2, -r * 0.12, -r * 0.18, -r * 0.32, 0, -r * 0.56);
  ctx.fill();
  const og = ctx.createRadialGradient(-r * 0.2, -r * 0.3, r * 0.04, 0, r * 0.16, r * 0.6);
  og.addColorStop(0, "#ffe9a8");
  og.addColorStop(0.4, "#ffb020");
  og.addColorStop(0.82, "#ff3d00");
  og.addColorStop(1, "#a91d0d");
  ctx.fillStyle = og;
  ctx.shadowColor = "#ff6a00";
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.arc(0, r * 0.28, r * 0.48, 0, Math.PI * 2);
  ctx.fill();
  specular(ctx, -r * 0.2, r * 0.14, r * 0.1, r * 0.14, -0.6);
}
function burst(ctx, r) {
  ctx.shadowColor = "#ffffff";
  ctx.shadowBlur = r * 0.45;
  ctx.fillStyle = "#fff6cf";
  ctx.strokeStyle = "#ffd98a";
  ctx.lineWidth = r * 0.03;
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    const long = i % 2 === 0;
    const len2 = long ? r * 0.92 : r * 0.66;
    const half = long ? r * 0.1 : r * 0.12;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy;
    const py = dx;
    ctx.beginPath();
    ctx.moveTo(dx * r * 0.16 + px * half * 0.5, dy * r * 0.16 + py * half * 0.5);
    ctx.lineTo(dx * len2, dy * len2);
    ctx.lineTo(dx * r * 0.16 - px * half * 0.5, dy * r * 0.16 - py * half * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.32);
  core.addColorStop(0, "#ffffff");
  core.addColorStop(0.7, "#fff9e0");
  core.addColorStop(1, "#ffefb0");
  ctx.fillStyle = core;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
}
function swirl(ctx, r) {
  const sweep = (wide, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = wide;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, Math.PI * 0.12, Math.PI * 1.62);
    ctx.stroke();
  };
  ctx.shadowColor = "#1fb8ff";
  ctx.shadowBlur = r * 0.5;
  sweep(r * 0.16, "#0b6fff");
  ctx.shadowBlur = 0;
  sweep(r * 0.055, "#c6f1ff");
  const ex = Math.cos(Math.PI * 0.12) * r * 0.6;
  const ey = Math.sin(Math.PI * 0.12) * r * 0.6;
  const bg = ctx.createRadialGradient(ex - r * 0.1, ey - r * 0.12, r * 0.02, ex, ey, r * 0.2);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(0.5, "#5cdcff");
  bg.addColorStop(1, "#0b6fff");
  ctx.fillStyle = bg;
  ctx.shadowColor = "#4dd0ff";
  ctx.shadowBlur = r * 0.45;
  ctx.beginPath();
  ctx.arc(ex, ey, r * 0.17, 0, Math.PI * 2);
  ctx.fill();
}
function shieldIcon(ctx, r) {
  const sg = ctx.createLinearGradient(0, -r, 0, r);
  sg.addColorStop(0, "#ffffff");
  sg.addColorStop(0.28, "#e4ecf2");
  sg.addColorStop(0.7, "#9db0bf");
  sg.addColorStop(1, "#5f7485");
  ctx.fillStyle = sg;
  ctx.shadowColor = "#cfe7ff";
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.92);
  ctx.quadraticCurveTo(r * 0.92, -r * 0.48, r * 0.92, 0);
  ctx.quadraticCurveTo(r * 0.92, r * 0.56, 0, r * 0.95);
  ctx.quadraticCurveTo(-r * 0.92, r * 0.56, -r * 0.92, 0);
  ctx.quadraticCurveTo(-r * 0.92, -r * 0.48, 0, -r * 0.92);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = r * 0.05;
  ctx.strokeStyle = "#eaf4fb";
  ctx.stroke();
  ctx.lineWidth = r * 0.035;
  ctx.strokeStyle = "#40586a";
  ctx.stroke();
  ctx.strokeStyle = "#2fe6ff";
  ctx.lineWidth = r * 0.14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "#2fe6ff";
  ctx.shadowBlur = r * 0.32;
  ctx.beginPath();
  ctx.moveTo(-r * 0.42, r * 0.04);
  ctx.lineTo(-r * 0.1, r * 0.34);
  ctx.lineTo(r * 0.44, -r * 0.28);
  ctx.stroke();
}
function snowflake(ctx, r) {
  ctx.lineCap = "round";
  const trace = (w, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(dx * r * 0.14, dy * r * 0.14);
      ctx.lineTo(dx * r * 0.86, dy * r * 0.86);
      ctx.stroke();
      const bx = dx * r * 0.56;
      const by = dy * r * 0.56;
      ctx.beginPath();
      ctx.moveTo(bx - dy * r * 0.2, by + dx * r * 0.2);
      ctx.lineTo(bx + dy * r * 0.2, by - dx * r * 0.2);
      ctx.stroke();
    }
  };
  ctx.shadowColor = "#66d0ff";
  ctx.shadowBlur = r * 0.4;
  trace(r * 0.14, "rgba(125,220,255,0.5)");
  ctx.shadowBlur = 0;
  trace(r * 0.05, "#eafaff");
  ctx.fillStyle = "#bff0ff";
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + Math.PI / 6;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52, r * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.2);
  cg.addColorStop(0, "#ffffff");
  cg.addColorStop(1, "#a8e6ff");
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}
function doubleBall(ctx, r) {
  const g = ctx.createRadialGradient(-r * 0.58, -r * 0.18, r * 0.03, -r * 0.42, 0, r * 0.42);
  g.addColorStop(0, "#f0e0ff");
  g.addColorStop(0.55, "#b06bff");
  g.addColorStop(1, "#64209b");
  ctx.fillStyle = g;
  ctx.shadowColor = "#c77dff";
  ctx.shadowBlur = r * 0.4;
  ctx.beginPath();
  ctx.arc(-r * 0.42, 0, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  specular(ctx, -r * 0.54, -r * 0.12, r * 0.1, r * 0.13, -0.5);
  ctx.save();
  ctx.setLineDash([r * 0.11, r * 0.08]);
  ctx.strokeStyle = "#d18bff";
  ctx.lineWidth = r * 0.07;
  ctx.shadowColor = "#d18bff";
  ctx.shadowBlur = r * 0.35;
  ctx.beginPath();
  ctx.arc(r * 0.42, 0, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(209,139,255,0.16)";
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = r * 0.03;
  ctx.beginPath();
  ctx.moveTo(-r * 0.06, 0);
  ctx.lineTo(r * 0.06, 0);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(r * 0.42, 0, r * 0.07, 0, Math.PI * 2);
  ctx.fill();
}
function droplet(ctx, r) {
  const g = ctx.createLinearGradient(0, -r * 0.9, 0, r * 0.9);
  g.addColorStop(0, "#e6ffa3");
  g.addColorStop(0.45, "#a4f74f");
  g.addColorStop(1, "#2f9e37");
  ctx.fillStyle = g;
  ctx.shadowColor = "#8dff54";
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.86);
  ctx.bezierCurveTo(r * 0.84, r * 0.12, r * 0.5, r * 0.9, 0, r * 0.9);
  ctx.bezierCurveTo(-r * 0.5, r * 0.9, -r * 0.84, r * 0.12, 0, -r * 0.86);
  ctx.fill();
  ctx.shadowBlur = 0;
  specular(ctx, -r * 0.28, r * 0.08, r * 0.16, r * 0.18, -0.6);
  const sx = r * 0.52;
  const sy = r * 0.4;
  const sr = r * 0.2;
  const sg = ctx.createLinearGradient(sx, sy - sr, sx, sy + sr);
  sg.addColorStop(0, "#e8ffb4");
  sg.addColorStop(1, "#3aa63f");
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.moveTo(sx, sy - sr);
  ctx.bezierCurveTo(sx + sr * 1.1, sy - sr * 0.1, sx + sr * 0.6, sy + sr, sx, sy + sr);
  ctx.bezierCurveTo(sx - sr * 0.6, sy + sr, sx - sr * 1.1, sy - sr * 0.1, sx, sy - sr);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.arc(sx - sr * 0.3, sy - sr * 0.25, sr * 0.28, 0, Math.PI * 2);
  ctx.fill();
}
function ropeKnot(ctx, r) {
  const bx = r * 0.3;
  const by = r * 0.28;
  const br = r * 0.2;
  const bg = ctx.createRadialGradient(bx - br * 0.4, by - br * 0.4, br * 0.08, bx, by, br * 1.2);
  bg.addColorStop(0, "#ffedcb");
  bg.addColorStop(0.55, "#d8a06a");
  bg.addColorStop(1, "#5f3512");
  ctx.fillStyle = bg;
  ctx.shadowColor = "#ffc77a";
  ctx.shadowBlur = r * 0.4;
  ctx.beginPath();
  ctx.arc(bx, by, br, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  specular(ctx, bx - br * 0.35, by - br * 0.35, br * 0.3, br * 0.22, -0.6);
  ctx.lineCap = "round";
  ctx.strokeStyle = "#6e4520";
  ctx.lineWidth = r * 0.13;
  ctx.beginPath();
  ctx.ellipse(-r * 0.06, -r * 0.02, r * 0.74, r * 0.6, 0.4, Math.PI * 1.05, Math.PI * 3.55);
  ctx.stroke();
  ctx.strokeStyle = "#e2b376";
  ctx.lineWidth = r * 0.05;
  ctx.shadowColor = "#f0c488";
  ctx.shadowBlur = r * 0.18;
  ctx.beginPath();
  ctx.ellipse(-r * 0.06, -r * 0.02, r * 0.74, r * 0.6, 0.4, Math.PI * 1.05, Math.PI * 3.55);
  ctx.stroke();
}
function volcano(ctx, r) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const base = ctx.createLinearGradient(0, 0, 0, r);
  base.addColorStop(0, "#ffcf70");
  base.addColorStop(1, "#e0492b");
  ctx.fillStyle = base;
  const rx = -r * 0.7;
  const ry = r * 0.42;
  const rw = r * 1.4;
  const rh = r * 0.22;
  const rad = r * 0.11;
  ctx.beginPath();
  ctx.moveTo(rx + rad, ry);
  ctx.lineTo(rx + rw - rad, ry);
  ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rad);
  ctx.lineTo(rx + rw, ry + rh - rad);
  ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rad, ry + rh);
  ctx.lineTo(rx + rad, ry + rh);
  ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rad);
  ctx.lineTo(rx, ry + rad);
  ctx.quadraticCurveTo(rx, ry, rx + rad, ry);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#7a2210";
  ctx.lineWidth = r * 0.025;
  ctx.stroke();
  const trace = (w, color, blur) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.beginPath();
    ctx.moveTo(-r * 0.56, r * 0.28);
    for (let i = 1; i <= 8; i++) {
      const nx = -r * 0.56 + i * (r * 1.12 / 8);
      const ny = r * 0.28 - (i % 2 ? r * 0.52 : r * 0.02);
      ctx.lineTo(nx, ny);
    }
    ctx.stroke();
  };
  trace(r * 0.1, "#ff9d45", r * 0.5);
  ctx.shadowBlur = 0;
  trace(r * 0.04, "#fff3cf", 0);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(-r * 0.78, -r * 0.05, r * 0.05, 0, Math.PI * 2);
  ctx.arc(r * 0.78, -r * 0.12, r * 0.045, 0, Math.PI * 2);
  ctx.fill();
}

// src/renderer.ts
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
    this.camAngle = 0;
    // world rotation applied this frame (camera keeps my goal at the bottom)
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
    const me = state.snap.players.find((p) => p.id === state.meID);
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
    this.camAngle = camAngle;
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
      ctx.translate(bx, by);
      ctx.rotate(-this.camAngle);
      drawItemIcon(ctx, key, 0, 0, iconR * pop);
      ctx.restore();
      if (age < 600) {
        ctx.save();
        ctx.globalAlpha = 1 - age / 600;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, iconR * (1.4 + age / 600 * 1.6), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
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
      const angle = p.id === state.meID ? state.myAngle : p.angle;
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
      halo.addColorStop(0.45, hexA2(color, 0.5));
      halo.addColorStop(1, hexA2(color, 0));
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
function hexA2(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const bl = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${bl},${a})`;
}

// src/ui.ts
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
function renderPlayers(container, snap, youId, isHost, onKick) {
  container.innerHTML = "";
  snap.players.forEach((p, i) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = playerColor(i);
    dot.style.color = playerColor(i);
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = p.name + (p.isHost ? " \u2605" : "") + (!p.isAlive ? " \xB7 \u043D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u0435\u043B\u044C" : "");
    li.append(dot, name);
    if (isHost && p.id !== youId && !p.isBot) {
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
function renderLobby(snap, youId, link, onKick) {
  $("lobby-room-id").textContent = snap.roomID;
  $("lobby-link").value = link;
  const isHost = snap.players.some((p) => p.id === youId && p.isHost);
  renderPlayers($("lobby-players"), snap, youId, isHost, onKick);
  $("btn-start").classList.toggle("hidden", !isHost);
  $("lobby-status").textContent = isHost ? "\u0412\u044B \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u044C \u2014 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041D\u0430\u0447\u0430\u0442\u044C \u0438\u0433\u0440\u0443\xBB, \u043A\u043E\u0433\u0434\u0430 \u0432\u0441\u0435 \u0433\u043E\u0442\u043E\u0432\u044B." : "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u0435\u043C...";
}
function renderGameOverPlayers(snap, youId, onKick) {
  const isHost = snap.players.some((p) => p.id === youId && p.isHost);
  renderPlayers($("game-over-kick-list"), snap, youId, isHost, onKick);
}
function renderHUD(snap, elapsedSec) {
  const wrap = $("hud-players");
  wrap.innerHTML = "";
  for (const p of snap.players) {
    const item = document.createElement("div");
    item.className = "hud-player" + (p.isAlive ? "" : " dead");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = playerColor(Math.max(0, p.index));
    dot.style.color = playerColor(Math.max(0, p.index));
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
function updateItemSlot(snap, youId) {
  const slot = $("item-slot");
  const cv = $("item-slot-canvas");
  const hint = $("item-slot-hint");
  slot.classList.toggle("hidden", !snap.items);
  if (!snap.items) return;
  const me = snap.players.find((p) => p.id === youId);
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

// src/sound.ts
var SFX_VOL_KEY = "neonpong.vol.sfx";
var MUSIC_VOL_KEY = "neonpong.vol.music";
var AUDIO = {
  music: "audio/music.wav",
  hitWall: "audio/hit-wall.wav",
  hitPaddle: "audio/hit-paddle.wav",
  click: "audio/click.wav",
  win: "audio/win.wav",
  miss: ["audio/miss/miss-1.wav", "audio/miss/miss-2.wav", "audio/miss/miss-3.wav"]
};
var clamp01 = (n) => Math.max(0, Math.min(1, n));
function loadVol(key, dflt) {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return isFinite(v) ? clamp01(v) : dflt;
}
function saveVol(key, v) {
  localStorage.setItem(key, String(clamp01(v)));
}
var SoundManager = class {
  constructor() {
    this.sfxVol = loadVol(SFX_VOL_KEY, 0.8);
    this.musicVol = loadVol(MUSIC_VOL_KEY, 0.55);
    this.musicEl = null;
    this.pools = /* @__PURE__ */ new Map();
    this.lastSfx = 0;
    this.lastClick = 0;
    this.started = false;
    const unlock = () => {
      if (!this.started) {
        this.started = true;
        this.startMusic();
      }
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });
    window.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        if (t && (t.tagName === "BUTTON" || t.classList.contains("btn"))) this.click();
      },
      { passive: true }
    );
  }
  get sfxVolume() {
    return this.sfxVol;
  }
  get musicVolume() {
    return this.musicVol;
  }
  setSfxVolume(v) {
    this.sfxVol = clamp01(v);
    saveVol(SFX_VOL_KEY, this.sfxVol);
  }
  setMusicVolume(v) {
    this.musicVol = clamp01(v);
    saveVol(MUSIC_VOL_KEY, this.musicVol);
    if (this.musicEl) this.musicEl.volume = this.musicVol;
    if (this.started) this.startMusic();
  }
  /** Starts looping background music (safe to call repeatedly). */
  startMusic() {
    if (!this.musicEl) {
      const m2 = new Audio(AUDIO.music);
      m2.loop = true;
      m2.preload = "auto";
      m2.volume = this.musicVol;
      this.musicEl = m2;
    }
    const m = this.musicEl;
    if (this.musicVol <= 0) {
      m.pause();
      return;
    }
    if (m.paused) m.play().catch(() => {
    });
  }
  /** Play a pooled cue; returns immediately if throttled or muted. */
  sfx(file, pitch, minGapMs) {
    const now = performance.now();
    if (now - this.lastSfx < minGapMs || this.sfxVol <= 0) return;
    this.lastSfx = now;
    let pool = this.pools.get(file);
    if (!pool) {
      pool = [];
      this.pools.set(file, pool);
    }
    let el = pool.find((a) => a.paused || a.ended);
    if (!el) {
      if (pool.length >= 6) return;
      el = new Audio(file);
      pool.push(el);
    }
    el.volume = this.sfxVol;
    if (pitch !== 1) el.playbackRate = pitch;
    el.currentTime = 0;
    el.play().catch(() => {
    });
  }
  /** Ball hit a plain wall. */
  hitWall() {
    this.sfx(AUDIO.hitWall, 0.95 + Math.random() * 0.12, 30);
  }
  /** Ball hit a paddle. */
  hitPaddle() {
    this.sfx(AUDIO.hitPaddle, 0.9 + Math.random() * 0.2, 40);
  }
  /** UI button click. */
  click() {
    const now = performance.now();
    if (now - this.lastClick < 70) return;
    this.lastClick = now;
    this.sfx(AUDIO.click, 1, 0);
  }
  /** Match won. */
  win() {
    this.sfx(AUDIO.win, 1, 0);
  }
  /** "You let the ball in" — random file from the miss folder. */
  miss() {
    const list = AUDIO.miss;
    if (list.length === 0) return;
    const f = list[Math.floor(Math.random() * list.length)];
    this.sfx(f, 1, 0);
  }
};
var sound = new SoundManager();

// src/main.ts
var NAME_KEY = "neonpong.name";
var net = null;
var renderer = null;
var clock = new NetClock();
var buffer = new SnapshotBuffer();
var meID = "";
var latestSnap = null;
var myAngle = 0.5;
var serverMyAngle = 0.5;
var inputDir = 0;
var inputSeq = 0;
var serverLastSeq = 0;
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
var lastAnchorAt = 0;
var keys = { left: false, right: false };
var rooms = [];
var lastLobbySig = "";
var lastGameOverSig = "";
var gameOverInitDone = false;
var joinRoomID = "";
var connContext = "menu";
var botMode = false;
var botStarted = false;
var myName = localStorage.getItem(NAME_KEY) || "";
function init() {
  bindCreatePanel();
  bindButtons();
  bindKeys();
  bindVolumePanel();
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
  $("btn-bot").addEventListener("click", openBotMode);
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
  $("btn-reset-ball").addEventListener("click", () => {
    net?.send({ action: "reset_ball" });
  });
  $("btn-audio").addEventListener("click", () => {
    $("audio-panel").classList.toggle("hidden");
  });
  $("btn-lobby-back").addEventListener("click", leaveToMenu);
  $("btn-restart").addEventListener("click", () => {
    $("game-over").classList.add("hidden");
    net?.send({ action: "start" });
  });
  $("btn-again").addEventListener("click", leaveToMenu);
}
function bindVolumePanel() {
  const sfx = $("vol-sfx");
  const music = $("vol-music");
  const sfxLabel = $("val-vol-sfx");
  const musicLabel = $("val-vol-music");
  const paint = () => {
    sfxLabel.textContent = String(Math.round(sound.sfxVolume * 100));
    musicLabel.textContent = String(Math.round(sound.musicVolume * 100));
    sfx.value = String(Math.round(sound.sfxVolume * 100));
    music.value = String(Math.round(sound.musicVolume * 100));
  };
  paint();
  sfx.addEventListener("input", () => {
    sound.setSfxVolume(Number(sfx.value) / 100);
    sfxLabel.textContent = sfx.value;
  });
  music.addEventListener("input", () => {
    sound.setMusicVolume(Number(music.value) / 100);
    musicLabel.textContent = music.value;
  });
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
    sendMove(dir, true);
  }
}
function sendMove(dir, withAngle) {
  if (!net) return;
  const me = latestSnap?.players.find((p) => p.id === meID);
  if (!me || !me.isAlive) return;
  const screenDir = renderer ? renderer.getFaceScreenDirX() : 1;
  inputSeq++;
  const msg = {
    action: "move",
    dir: dir * screenDir,
    seq: inputSeq,
    lag: net.getLatency()
  };
  if (withAngle) msg.angle = myAngle;
  net.send(msg);
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
  botMode = false;
  botStarted = false;
  setBotModeUI(false);
  $("create-name").value = myName;
  showFormError("create", null);
  showScreen("create");
}
function setBotModeUI(on) {
  $("create-room-field").classList.toggle("hidden", on);
  $("create-pass-field").classList.toggle("hidden", on);
  $("create-max-field").classList.toggle("hidden", on);
  $("bot-note").classList.toggle("hidden", !on);
  $("btn-create-go").textContent = on ? "\u0418\u0433\u0440\u0430\u0442\u044C \u0441 \u0431\u043E\u0442\u043E\u043C" : "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u043A\u043E\u043C\u043D\u0430\u0442\u0443";
}
function openBotMode() {
  botMode = true;
  botStarted = false;
  setBotModeUI(true);
  $("create-name").value = myName;
  $("inp-items").checked = true;
  showFormError("create", null);
  showScreen("create");
  $("create-name").focus();
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
  botMode = false;
  botStarted = false;
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
  const vsBot = botMode;
  if (!vsBot && !name) {
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
        items,
        vsBot,
        bots: 1
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
    onLatency: (oneWayMs) => clock.updateRtt(oneWayMs),
    onSnapshot: handleSnapshot,
    onSfx: (events) => {
      for (const e of events) {
        if (e.k === "wall") sound.hitWall();
        else if (e.k === "paddle") sound.hitPaddle();
        else if (e.k === "miss" && e.p === meID) sound.miss();
      }
    },
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
  clock.observe(snap);
  const me = snap.players.find((p) => p.id === meID);
  $("btn-reset-ball").classList.toggle("hidden", !(snap.state === "playing" && snap.host === meID));
  if (snap.state === "waiting") {
    playing = false;
    showScreen("lobby");
    if (botMode && !botStarted) {
      const meHost = snap.host === meID;
      if (meHost) {
        botStarted = true;
        net?.send({ action: "start" });
      }
    }
    const sig = playersSignature(snap);
    if (sig !== lastLobbySig) {
      lastLobbySig = sig;
      renderLobby(snap, meID, buildInviteLink(snap.roomID), kickPlayer);
    }
  } else if (snap.state === "playing") {
    updateItemSlot(snap, meID);
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
  const me = snap.players.find((p) => p.id === meID);
  const myIndex = me && me.isAlive ? me.index : -1;
  if (!renderer) renderer = new GameRenderer($("game-canvas"));
  renderer.resize();
  renderer.setup(snap.sides, snap.radius, snap.chamfer, snap.paddleHalf, snap.ballRadius, myIndex);
  currentSides = snap.sides;
  currentMyIndex = myIndex;
}
function startPlaying(snap) {
  playing = true;
  wasAlive = true;
  matchStartTime = performance.now();
  gameOverInitDone = false;
  const me = snap.players.find((p) => p.id === meID);
  myAngle = me ? me.angle : 0.5;
  serverMyAngle = myAngle;
  keys.left = keys.right = false;
  inputDir = 0;
  if (net) {
    inputSeq++;
    net.send({ action: "move", dir: 0, seq: inputSeq, lag: net.getLatency() });
  }
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
  stepMyPaddle(dt);
  if (now - lastAnchorAt >= 100) {
    lastAnchorAt = now;
    sendMove((keys.right ? 1 : 0) + (keys.left ? -1 : 0), true);
  }
  if (renderer && latestSnap) {
    const renderTime = clock.renderTime;
    const players = buffer.playersAt(renderTime) ?? latestSnap.players;
    renderer.render({
      snap: latestSnap,
      players,
      myAngle,
      meID,
      balls: buffer.ballsAt(renderTime) ?? latestSnap.balls
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
    if (Math.abs(serverMyAngle - myAngle) > 0.25) {
      myAngle = serverMyAngle;
    }
  }
}
function showGameOver(snap) {
  stopLoop();
  showScreen("game");
  if (renderer && latestSnap) {
    const renderTime = clock.renderTime;
    const players = buffer.playersAt(renderTime) ?? latestSnap.players;
    renderer.render({
      snap: latestSnap,
      players,
      myAngle,
      meID,
      balls: buffer.ballsAt(renderTime) ?? latestSnap.balls
    });
  }
  const winner = snap.players.find((p) => p.id === snap.winner);
  let text;
  if (!winner) text = "\u041D\u0438\u0447\u044C\u044F";
  else if (winner.id === meID) text = "\u{1F3C6} \u0412\u044B \u043F\u043E\u0431\u0435\u0434\u0438\u043B\u0438!";
  else text = `\u041F\u043E\u0431\u0435\u0434\u0438\u043B: ${winner.name}`;
  $("game-over-text").textContent = text;
  renderHUD(snap, (performance.now() - matchStartTime) / 1e3);
  const me = snap.players.find((p) => p.id === meID);
  const isHost = !!me?.isHost;
  $("btn-restart").classList.toggle("hidden", !isHost);
  $("game-over-config").classList.toggle("hidden", !isHost);
  $("game-over-players").textContent = isHost ? `\u0418\u0433\u0440\u043E\u043A\u043E\u0432 \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0435: ${snap.players.length} \u2014 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u0442\u0435 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u0418\u0433\u0440\u0430\u0442\u044C \u0441\u043D\u043E\u0432\u0430\xBB` : "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u0442\u0435\u043B\u0435\u043C...";
  if (!gameOverInitDone) {
    gameOverInitDone = true;
    if (winner && winner.id === meID) sound.win();
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
    renderGameOverPlayers(snap, meID, kickPlayer);
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
  $("audio-panel").classList.add("hidden");
  backToMenu();
}
function buildInviteLink(roomID) {
  return `${location.origin}${location.pathname}?room=${roomID}`;
}
init();
