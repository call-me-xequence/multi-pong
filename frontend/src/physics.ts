// physics.ts — client-side prediction of the ball (deterministic physics that
// mirrors the server) plus a snapshot buffer used to interpolate other players'
// paddles.

import { buildWalls, closestPointOnSegment, type Seg } from './geometry.js';
import type { Snapshot, SnapshotPlayer } from './types.js';

export interface SimBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// Default interpolation delay for other players' paddles (the ball itself is
// predicted at "now", so it stays in sync with my paddle).
export const RENDER_DELAY_MS = 80;

const CORRECTION_MS = 100;     // error-correction blend window
const CORRECTION_THRESHOLD = 20; // px of error before we correct the ball
const MAX_FRAME_DT = 0.05;     // clamp tab-switch spikes

export class LocalPhysics {
  private walls: Seg[] = [];
  private ballRadius = 9;
  private balls: SimBall[] = [];
  private corrections: { x: number; y: number }[] = [];

  // One-way network latency in seconds; used to align predicted balls with
  // authoritative snapshots (server state is this far in the past).
  latencySec = 0.06;

  private timeBase = false;
  private refServerT = 0;
  private refClientNow = 0;
  private delayMs = RENDER_DELAY_MS;

  setup(sides: number, radius: number, chamfer: number, ballRadius: number): void {
    this.walls = buildWalls(sides, radius, chamfer);
    this.ballRadius = ballRadius;
  }

  /** Establishes the client<->server clock mapping. */
  sync(snap: Snapshot): void {
    if (!this.timeBase) {
      this.refServerT = snap.t;
      this.refClientNow = performance.now();
      this.timeBase = true;
    }
  }

  /** Server's wall-clock time right now (estimated). */
  estimatedServerNow(): number {
    if (!this.timeBase) return 0;
    return this.refServerT + (performance.now() - this.refClientNow);
  }

  /** Adjust the interpolation delay (for other players' paddles). */
  setDelay(ms: number): void {
    this.delayMs = Math.max(40, Math.min(300, ms));
  }

  get renderTime(): number {
    return this.estimatedServerNow() - this.delayMs;
  }

  /** Re-syncs the predicted balls with a fresh authoritative snapshot. */
  onSnapshot(snap: Snapshot): void {
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

      // The server snapshot is ~latency old; extrapolate it to "now" and
      // compare against our predicted position.
      const tx = s.x + s.vx * lead;
      const ty = s.y + s.vy * lead;
      const ex = tx - b.x;
      const ey = ty - b.y;
      const err = Math.hypot(ex, ey);

      this.corrections[i] = err > CORRECTION_THRESHOLD ? { x: ex, y: ey } : { x: 0, y: 0 };

      // Keep velocity aligned with the authoritative server velocity.
      b.vx = s.vx;
      b.vy = s.vy;
    }
  }

  /** Advances the local ball simulation (called every animation frame). */
  step(dt: number): void {
    if (dt <= 0) return;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      this.collideBall(b);

      // Apply the error correction gradually over CORRECTION_MS.
      const c = this.corrections[i];
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
 * SnapshotBuffer stores recent snapshots and interpolates other players'
 * paddles at an arbitrary past server time.
 */
export class SnapshotBuffer {
  private snaps: Snapshot[] = [];

  push(snap: Snapshot): void {
    this.snaps.push(snap);
    if (this.snaps.length > 32) this.snaps.shift();
  }

  latest(): Snapshot | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  /** Drops all buffered snapshots (e.g. after the arena re-formed). */
  clear(): void {
    this.snaps = [];
  }

  /** Finds the two snapshots bracketing `renderTime` and the blend factor f. */
  private bracketing(renderTime: number): [Snapshot, Snapshot, number] | null {
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
  playersAt(renderTime: number): SnapshotPlayer[] | null {
    const br = this.bracketing(renderTime);
    if (!br) return null;
    const [a, b, f] = br;

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
