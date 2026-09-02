// physics.ts — snapshot interpolation for the ball and other players' paddles,
// plus a small clock that maps client time to server time.

import type { Snapshot, SnapshotPlayer, SnapshotBall } from './types.js';

export interface SimBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// How far in the past (server time) we render. Rendering slightly in the past
// lets us interpolate between two authoritative snapshots, which is smooth and
// jitter-free — the server stays the single source of truth.
export const RENDER_DELAY_MS = 80;

/**
 * Clock maps the local monotonic clock to the server's clock, so we can ask
 * "what did the server state look like at time T?" even between snapshots.
 */
export class LocalPhysics {
  private timeBase = false;
  private refServerT = 0;
  private refClientNow = 0;
  private delayMs = RENDER_DELAY_MS;

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

  /** Adjust the interpolation delay based on measured network latency. */
  setDelay(ms: number): void {
    this.delayMs = Math.max(40, Math.min(300, ms));
  }

  /** Server time at which we render: a little in the past to hide network jitter. */
  get renderTime(): number {
    return this.estimatedServerNow() - this.delayMs;
  }
}

/**
 * SnapshotBuffer stores recent snapshots and interpolates state at an arbitrary
 * past server time. Interpolation (rather than prediction) is what makes the
 * ball move smoothly: the client just blends between the server's most recent
 * confirmed states instead of trying to simulate physics it can't predict
 * exactly (random wall perturbation, paddle steering).
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

  /** Returns balls interpolated to the given server time. */
  ballsAt(renderTime: number): SnapshotBall[] | null {
    const br = this.bracketing(renderTime);
    if (!br) return null;
    const [a, b, f] = br;

    // Ball count changed (goal / respawn): show the newer state as-is.
    if (a.balls.length !== b.balls.length) return b.balls;

    return b.balls.map((bb, i) => {
      const ba = a.balls[i];
      return {
        x: ba.x + (bb.x - ba.x) * f,
        y: ba.y + (bb.y - ba.y) * f,
        vx: bb.vx,
        vy: bb.vy,
      };
    });
  }
}
