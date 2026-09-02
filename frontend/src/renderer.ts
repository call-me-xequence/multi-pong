// renderer.ts — draws the arena with a camera that keeps "my goal" at the bottom.

import {
  buildWalls,
  faceMidAngle,
  add,
  sub,
  mul,
  norm,
  type Seg,
} from './geometry.js';
import type { Snapshot, SnapshotPlayer } from './types.js';
import type { SimBall } from './physics.js';

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

export class GameRenderer {
  private ctx: CanvasRenderingContext2D;
  private walls: Seg[] = [];
  private radius = 300;
  private chamfer = 40;
  private paddleHalf = 0.11;
  private ballRadius = 9;
  private sides = 6;
  private myIndex = 0;

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

  render(state: RenderState): void {
    const ctx = this.ctx;
    if (this.canvas.width === 0 || this.canvas.height === 0) this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Background.
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#0a1020');
    bg.addColorStop(1, '#020409');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Camera: rotate so that my face is at the bottom.
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

    if (state.balls.length === 0 && state.snap.respawnIn && state.snap.respawnIn > 0) {
      this.drawCountdown(state.snap.respawnIn);
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

  private drawPaddles(state: RenderState): void {
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
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawBalls(state: RenderState): void {
    const ctx = this.ctx;
    for (const b of state.balls) {
      ctx.save();
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 30;

      const halo = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, this.ballRadius * 3.2);
      halo.addColorStop(0, 'rgba(255,255,255,1)');
      halo.addColorStop(0.35, 'rgba(0,240,255,0.9)');
      halo.addColorStop(1, 'rgba(0,240,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(b.x, b.y, this.ballRadius * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, this.ballRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}
