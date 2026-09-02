// physics.ts — local simulation of the ball (client-side prediction) plus a
// snapshot buffer used to interpolate other players' paddles.

import { buildWalls, closestPointOnSegment, type Seg } from './geometry.js';
import type { Snapshot, SnapshotPlayer } from './types.js';

export interface SimBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export const RENDER_DELAY_MS = 100; // render 100ms in the past for other players
export const CORRECTION_MS = 100;   // error-correction blend window
const CORRECTION_THRESHOLD = 14;    // px of error before we correct the ball
const MAX_FRAME_DT = 0.05;          // clamp tab-switch spikes

export class LocalPhysics {
  private walls: Seg[] = [];
  private radius = 300;
  private ballRadius = 9;
  private ballSpeed = 260;

  private balls: SimBall[] = [];
  private correction: { x: number; y: number }[] = [];

  private timeBase = false;
  private refServerT = 0;
  private refClientNow = 0;

  setup(sides: number, radius: number, chamfer: number, ballRadius: number, ballSpeed: number): void {
    this.walls = buildWalls(sides, radius, chamfer);
    this.radius = radius;
    this.ballRadius = ballRadius;
    this.ballSpeed = ballSpeed;
  }

  /** Maps client wall-clock time to the server's clock. */
  estimatedServerNow(): number {
    if (!this.timeBase) return 0;
    return this.refServerT + (performance.now() - this.refClientNow);
  }

  /** Server time at which we render other players (a small delay hides jitter). */
  get renderTime(): number {
    return this.estimatedServerNow() - RENDER_DELAY_MS;
  }

  /** Called whenever a fresh server snapshot arrives. */
  onSnapshot(snap: Snapshot): void {
    if (!this.timeBase) {
      this.refServerT = snap.t;
      this.refClientNow = performance.now();
      this.timeBase = true;
    }

    while (this.balls.length < snap.balls.length) {
      this.balls.push({ x: 0, y: 0, vx: 0, vy: 0 });
      this.correction.push({ x: 0, y: 0 });
    }
    this.balls.length = snap.balls.length;
    this.correction.length = snap.balls.length;

    const lead = RENDER_DELAY_MS / 1000;
    for (let i = 0; i < snap.balls.length; i++) {
      const s = snap.balls[i];
      const b = this.balls[i];

      // Where the local ball *should* be, extrapolating the server state forward.
      const tx = s.x + s.vx * lead;
      const ty = s.y + s.vy * lead;
      const ex = tx - b.x;
      const ey = ty - b.y;
      const err = Math.hypot(ex, ey);

      if (err > CORRECTION_THRESHOLD) {
        this.correction[i] = { x: ex, y: ey };
      } else {
        this.correction[i] = { x: 0, y: 0 };
      }

      // Always align velocity with the authoritative server velocity so the
      // local prediction stays on track after bounces.
      b.vx = s.vx;
      b.vy = s.vy;
    }
  }

  /** Advances the local simulation by dt seconds (called every animation frame). */
  step(dt: number): void {
    if (dt <= 0) return;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      this.collideBall(b);

      // Apply the error correction gradually over CORRECTION_MS.
      const c = this.correction[i];
      const k = Math.min(1, (dt * 1000) / CORRECTION_MS);
      b.x += c.x * k;
      b.y += c.y * k;
      c.x -= c.x * k;
      c.y -= c.y * k;
    }
  }

  private collideBall(b: SimBall): void {
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

  getBalls(): SimBall[] {
    return this.balls;
  }
}

/**
 * SnapshotBuffer stores recent snapshots and interpolates player paddles at an
 * arbitrary past server time, which hides network jitter for other players.
 */
export class SnapshotBuffer {
  private snaps: Snapshot[] = [];

  push(snap: Snapshot): void {
    this.snaps.push(snap);
    if (this.snaps.length > 12) this.snaps.shift();
  }

  latest(): Snapshot | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  /** Returns player paddles interpolated to the given server time. */
  playersAt(renderTime: number): SnapshotPlayer[] | null {
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

    if (renderTime > b.t) {
      return b.players;
    }
    if (renderTime < a.t) {
      return a.players;
    }

    const span = b.t - a.t || 1;
    const f = (renderTime - a.t) / span;
    const byId = new Map<string, SnapshotPlayer>();
    for (const p of a.players) byId.set(p.id, p);

    const out: SnapshotPlayer[] = [];
    for (const pb of b.players) {
      const pa = byId.get(pb.id);
      if (!pa) {
        out.push(pb);
        continue;
      }
      out.push({
        ...pb,
        angle: pa.angle + (pb.angle - pa.angle) * f,
      });
    }
    return out;
  }
}
