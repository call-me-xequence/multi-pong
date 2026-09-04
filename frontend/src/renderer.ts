// renderer.ts — draws the arena with a camera that keeps "my goal" at the
// bottom, plus item effects (paddle icons, ball styles, ropes, flash & shake).

import {
  buildWalls,
  faceMidAngle,
  add,
  sub,
  mul,
  norm,
  perp,
  len,
  type Seg,
  type Pt,
} from './geometry.js';
import type { Snapshot, SnapshotBall, SnapshotPlayer } from './types.js';
import type { SimBall } from './physics.js';
import { drawItemIcon } from './items.js';

export interface RenderState {
  snap: Snapshot;
  players: SnapshotPlayer[]; // interpolated paddles for other players
  myAngle: number;           // locally predicted paddle position of me
  balls: SimBall[];          // locally predicted balls
}

const PALETTE = ['#00f0ff', '#ff3df0', '#ffe600', '#39ff6a', '#ff7a00', '#9d6bff'];

export function playerColor(index: number): string {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** The item "state" to show behind a goal (active/armed/just-used), or null. */
function paddleFxKey(p: SnapshotPlayer): string | null {
  const fx = p.fx;
  if (fx && (fx.fire ?? 0) > 0) return 'fire';
  if (fx && (fx.sticky ?? 0) > 0) return 'sticky';
  if (fx && (fx.shield ?? 0) > 0) return 'shield';
  // A short guaranteed window right after the player pressed Space, so every
  // item (and every viewer, including other players) sees the icon.
  if (p.use && (p.useT ?? 0) > 0) return p.use;
  if (p.arm) return p.arm;
  return null;
}

/** Ball colour for the given snapshot ball effect. */
function ballColor(fx?: SnapshotBall): string {
  if (!fx) return '#00f0ff';
  if (fx.fire) return '#ffb020';
  if (fx.sticky) return '#7bff5a';
  if ((fx.cv ?? 0) > 0) return '#4dd0ff';
  if (fx.fake || fx.tether) return '#c084fc';
  return '#00f0ff';
}

export class GameRenderer {
  private ctx: CanvasRenderingContext2D;
  private walls: Seg[] = [];
  private radius = 300;
  private chamfer = 40;
  private paddleHalf = 0.11;
  private ballRadius = 9;
  private sides = 6;
  private myIndex = 0;
  private camAngle = 0; // world rotation applied this frame (camera keeps my goal at the bottom)
  private fxSeen = new Map<string, number>(); // key -> first-seen ms, pop anims

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  setup(
    sides: number,
    radius: number,
    chamfer: number,
    paddleHalf: number,
    ballRadius: number,
    myIndex: number,
  ): void {
    this.sides = sides;
    this.radius = radius;
    this.chamfer = chamfer;
    this.paddleHalf = paddleHalf;
    this.ballRadius = ballRadius;
    this.myIndex = myIndex;
    this.walls = buildWalls(sides, radius, chamfer);
  }

  /** Screen-space direction (+1/-1) along which "increasing angle" moves the paddle. */
  getFaceScreenDirX(): number {
    const seg = this.walls[2 * this.myIndex];
    if (!seg) return 1;
    const t = norm(sub(seg.b, seg.a));
    const faceAngle = faceMidAngle(this.sides, this.myIndex);
    const cam = Math.PI / 2 - faceAngle;
    const sx = t.x * Math.cos(cam) - t.y * Math.sin(cam);
    return sx >= 0 ? 1 : -1;
  }

  private meFx(state: RenderState): Record<string, number> | undefined {
    const me = state.snap.players.find((p) => p.id === state.snap.you);
    return me ? me.fx : undefined;
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    if (this.canvas.width === 0 || this.canvas.height === 0) this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#0a1020');
    bg.addColorStop(1, '#020409');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const camAngle = this.myIndex >= 0 ? Math.PI / 2 - faceMidAngle(this.sides, this.myIndex) : 0;
    this.camAngle = camAngle;
    const scale = this.fitScale(w, h);
    const cx = w / 2;
    const cy = h / 2;

    // Screen shake (volcano item) for the local viewer.
    let sx = 0;
    let sy = 0;
    const shakeSec = this.meFx(state)?.shake ?? 0;
    if (shakeSec > 0) {
      const t = performance.now() / 1000;
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

    if (
      state.snap.state === 'playing' &&
      state.balls.length === 0 &&
      state.snap.respawnIn &&
      state.snap.respawnIn > 0
    ) {
      this.drawCountdown(state.snap.respawnIn);
    }
  }

  private drawScreenFx(state: RenderState, sx: number, sy: number): void {
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
    // subtle vignette during shake
    if ((fx?.shake ?? 0) > 0 && (sx !== 0 || sy !== 0)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(180,80,40,0.25)';
      ctx.lineWidth = Math.max(this.canvas.width, this.canvas.height) * 0.16;
      ctx.shadowColor = 'rgba(120,40,20,0.6)';
      ctx.shadowBlur = 30;
      ctx.strokeRect(-this.canvas.width * 0.2, -this.canvas.height * 0.2, this.canvas.width * 1.4, this.canvas.height * 1.4);
      ctx.restore();
    }
  }

  private drawCountdown(seconds: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 22;
    ctx.fillText(`Мяч через ${Math.ceil(seconds)}`, this.canvas.width / 2, this.canvas.height / 2);
    ctx.restore();
  }

  private fitScale(w: number, h: number): number {
    const margin = this.chamfer + this.ballRadius * 3 + 30;
    return Math.min(w, h) / 2 / (this.radius + margin);
  }

  private drawRing(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,240,255,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius + this.chamfer, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawArena(state: RenderState): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowBlur = 18;

    for (let i = 0; i < this.walls.length; i++) {
      const seg = this.walls[i];
      const isFace = i % 2 === 0;
      const faceIdx = i / 2;
      const player = isFace
        ? state.snap.players.find((p) => p.index === faceIdx)
        : undefined;

      if (isFace && player) {
        if (!player.isAlive) {
          ctx.shadowColor = '#ff2244';
          ctx.strokeStyle = 'rgba(255,45,70,0.9)';
        } else if ((player.fx?.shield ?? 0) > 0) {
          // Shielded goal gleams silver.
          ctx.shadowColor = '#e8eef2';
          ctx.strokeStyle = 'rgba(224,236,244,0.95)';
        } else {
          const col = playerColor(player.index);
          ctx.shadowColor = col;
          ctx.strokeStyle = col;
        }
      } else {
        ctx.shadowColor = 'rgba(0,240,255,0.7)';
        ctx.strokeStyle = 'rgba(0,240,255,0.45)';
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
  private drawRopes(state: RenderState): void {
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
      const ropeLen = 4 * faceLen * this.paddleHalf; // two paddle lengths
      const ac = add(seg.a, mul(sub(seg.b, seg.a), anchor.angle));
      const from: Pt = { x: b.x, y: b.y };
      const dx = from.x - ac.x;
      const dy = from.y - ac.y;
      const d = Math.hypot(dx, dy);
      const taut = d >= ropeLen;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.shadowColor = '#8a5a2b';
      ctx.shadowBlur = 6;
      ctx.strokeStyle = '#b08050';
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
  private drawPlayerFx(state: RenderState): void {
    const ctx = this.ctx;
    const faceLen = 2 * this.radius * Math.sin(Math.PI / this.sides);
    const byId = new Map<string, SnapshotPlayer>();
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

      // Fixed spot OUTSIDE the playing field, centred on this player's goal
      // face (icons do not follow the paddle).
      const mid = mul(add(seg.a, seg.b), 0.5);
      const n = norm(mid); // outward normal, away from the arena centre
      const iconR = faceLen * 0.11;
      const off = faceLen * 0.22 + this.ballRadius * 2;
      const bx = mid.x + n.x * off;
      const by = mid.y + n.y * off;

      const seenKey = p.id + ':' + key;
      let first = this.fxSeen.get(seenKey);
      if (first === undefined) {
        first = now;
        this.fxSeen.set(seenKey, now);
      }
      const age = now - first;
      const pop = 1 + Math.max(0, 0.6 * Math.exp(-age * 0.006));

      ctx.save();
      ctx.globalAlpha = Math.min(1, 0.75 + age * 0.01);
      // Icons are drawn screen-upright (undo the world camera rotation around
      // the icon) so they read correctly from the local player's camera no
      // matter which goal they sit behind (the map rotates for every player).
      ctx.translate(bx, by);
      ctx.rotate(-this.camAngle);
      drawItemIcon(ctx, key, 0, 0, iconR * pop);
      ctx.restore();
      // Expanding ring when the effect just appeared so everyone notices.
      if (age < 600) {
        ctx.save();
        ctx.globalAlpha = 1 - age / 600;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, iconR * (1.4 + (age / 600) * 1.6), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // prune old entries
    if (this.fxSeen.size > 200) {
      for (const [k, t] of this.fxSeen) {
        if (now - t > 3000) this.fxSeen.delete(k);
      }
    }
  }

  private drawPaddles(state: RenderState): void {
    const ctx = this.ctx;
    const faceLen = 2 * this.radius * Math.sin(Math.PI / this.sides);
    const halfLen = faceLen * this.paddleHalf;
    const byId = new Map<string, SnapshotPlayer>();
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
      if (frozen) col = '#aee6ff';

      ctx.save();
      ctx.lineCap = 'round';
      ctx.shadowColor = col;
      ctx.shadowBlur = 24;
      ctx.strokeStyle = col;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Bright white core.
      ctx.shadowBlur = 8;
      ctx.strokeStyle = frozen ? '#eafcff' : '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Frozen: icy shards above the paddle.
      if (frozen) {
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#7fd8ff';
        ctx.lineWidth = 2.5;
        const t = performance.now() / 1000;
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
          ctx.lineTo(mx + (s * 4), my - 14);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  private drawBalls(state: RenderState): void {
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
      halo.addColorStop(0, 'rgba(255,255,255,0.95)');
      halo.addColorStop(0.45, hexA(color, 0.5));
      halo.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = fx?.fake ? 0.75 : 1;
      ctx.fillStyle = fx?.fire ? '#fff1c4' : fx?.sticky ? '#eaffd8' : '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, this.ballRadius, 0, Math.PI * 2);
      ctx.fill();

      // Style marks
      if (fx?.fire) {
        ctx.fillStyle = '#ff9f1a';
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 0.45, 0, Math.PI * 2);
        ctx.fill();
      } else if (fx?.sticky) {
        ctx.strokeStyle = '#3fa72f';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 1.15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if ((fx?.cv ?? 0) > 0) {
        ctx.strokeStyle = '#4dd0ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 0.6, Math.PI * 0.2, Math.PI * 1.4);
        ctx.stroke();
      } else if (fx?.fake || fx?.tether) {
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * 1.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if ((fx?.stuck ?? 0) > 0) {
        ctx.strokeStyle = 'rgba(127,255,90,0.8)';
        ctx.lineWidth = 3;
        const t = performance.now() / 1000;
        ctx.beginPath();
        ctx.arc(b.x, b.y, this.ballRadius * (1.25 + Math.sin(t * 6) * 0.08), 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    });
  }
}

// --- small canvas helpers ----------------------------------------------------

/** Converts "#rrggbb" + alpha to an rgba() string. */
function hexA(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const bl = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${bl},${a})`;
}
