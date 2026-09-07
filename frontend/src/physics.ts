// physics.ts — server-time clock plus a snapshot buffer that interpolates
// every remote entity (other paddles AND balls). No client-side ball
// prediction: the ball is drawn from interpolated server snapshots, so it
// never lags or snaps.

import type { Snapshot, SnapshotBall, SnapshotPlayer } from './types.js';

// Interpolation delay. Remote entities render at `serverNow - delay`, so there
// is always a past and a future snapshot to blend between.
export const RENDER_DELAY_MS = 80;

export class NetClock {
  private timeBase = false;
  private refServerT = 0;
  private refClientNow = 0;
  private delayMs = RENDER_DELAY_MS;

  /** Establishes the client<->server clock mapping. */
  sync(snap: Snapshot): void {
    if (!this.timeBase) {
      this.refServerT = snap.t;
      this.refClientNow = performance.now();
      this.timeBase = true;
    }
  }

  /** Adjust the interpolation delay. */
  setDelay(ms: number): void {
    this.delayMs = Math.max(40, Math.min(300, ms));
  }

  /** Server time the frame should render at (interpolation target). */
  get renderTime(): number {
    if (!this.timeBase) return 0;
    return this.refServerT + (performance.now() - this.refClientNow) - this.delayMs;
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

  /** Returns balls interpolated to the given server time. */
  ballsAt(renderTime: number): SnapshotBall[] | null {
    const br = this.bracketing(renderTime);
    if (!br) return null;
    const [a, b, f] = br;

    const n = Math.max(a.balls.length, b.balls.length);
    const out: SnapshotBall[] = [];
    for (let i = 0; i < n; i++) {
      const ba = a.balls[i];
      const bb = b.balls[i];
      if (ba && bb) {
        // Linear blend between the two authoritative positions.
        out.push({
          ...bb,
          x: ba.x + (bb.x - ba.x) * f,
          y: ba.y + (bb.y - ba.y) * f,
        });
      } else if (bb) {
        // Spawned between the two snapshots: show it at its first position.
        out.push(bb);
      }
      // Removed between snapshots (only ba): omit it.
    }
    return out;
  }
}
