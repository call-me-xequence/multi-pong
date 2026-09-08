// physics.ts — server-time clock plus a snapshot buffer that interpolates
// every remote entity (other paddles AND balls). No client-side ball
// prediction: the ball is drawn from interpolated server snapshots, so it
// never lags or snaps.

import type { Snapshot, SnapshotBall, SnapshotPlayer } from './types.js';

// Interpolation delay bounds (ms). Remote entities render at `serverNow - delay`,
// so the delay must cover the nominal snapshot cadence plus the network jitter
// to keep a past and a future snapshot available for blending.
export const MIN_RENDER_DELAY_MS = 40;
export const MAX_RENDER_DELAY_MS = 300;
const BASE_RENDER_DELAY_MS = 80; // fallback until we have measurements
const SNAPSHOT_INTERVAL_MS = 1000 / 64; // nominal snapshot cadence
const JITTER_K = 2; // how many jitter deviations the buffer must absorb

// How far ahead of the newest snapshot a ball may be extrapolated from its
// velocity before we give up and hold it still (avoids runaway drift after a
// real network stall; anything longer means the match is effectively paused).
const MAX_BALL_EXTRAP_MS = 120;

export class NetClock {
  private timeBase = false;
  private refServerT = 0;
  private refClientNow = 0;
  private delayMs = BASE_RENDER_DELAY_MS;

  // One-way latency and its mean deviation, EWMA-smoothed from ping RTTs.
  private latencyMs = 30;
  private rttJitterMs = 0;

  // Snapshot inter-arrival statistics (so bursts adapt the buffer immediately).
  private lastArrivalAt = 0;
  private arrivalJitterMs = 0;
  private haveArrival = false;

  /** Establishes the client<->server clock mapping (idempotent). */
  sync(snap: Snapshot): void {
    if (!this.timeBase) {
      this.refServerT = snap.t;
      this.refClientNow = performance.now();
      this.timeBase = true;
    }
  }

  /** Observe a snapshot arrival; tracks inter-arrival jitter and re-sizes. */
  observe(snap: Snapshot): void {
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
  updateRtt(oneWayMs: number): void {
    oneWayMs = Math.max(1, Math.min(250, oneWayMs));
    const dev = Math.abs(oneWayMs - this.latencyMs);
    this.latencyMs = this.latencyMs * 0.8 + oneWayMs * 0.2;
    this.rttJitterMs = this.rttJitterMs * 0.8 + dev * 0.2;
    this.recomputeDelay();
  }

  /** Buffer = latency + nominal snapshot cadence + k * worst jitter. */
  private recomputeDelay(): void {
    const jitter = Math.max(this.rttJitterMs, this.arrivalJitterMs);
    const want = this.latencyMs + SNAPSHOT_INTERVAL_MS * 2 + JITTER_K * jitter;
    this.delayMs = Math.max(MIN_RENDER_DELAY_MS, Math.min(MAX_RENDER_DELAY_MS, want));
  }

  /** Current interpolation delay, ms (read-only). */
  get delay(): number {
    return this.delayMs;
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

  /**
   * Returns balls interpolated to the given server time, or extrapolated from
   * velocity when the render time is ahead of the newest snapshot (a late
   * arrival). This keeps the ball moving smoothly through jitter spikes instead
   * of freezing at the last known position.
   */
  ballsAt(renderTime: number): SnapshotBall[] | null {
    const n = this.snaps.length;
    if (n === 0) return null;

    // Find the newest snapshot at or before renderTime — the "base".
    let i = 0;
    while (i < n - 1 && this.snaps[i + 1].t <= renderTime) i++;
    const a = this.snaps[i];
    const b = i + 1 < n ? this.snaps[i + 1] : null;

    if (b) {
      // Normal path: blend between the two bracketing authoritative positions.
      const span = b.t - a.t || 1;
      const f = Math.max(0, Math.min(1, (renderTime - a.t) / span));
      const cnt = Math.max(a.balls.length, b.balls.length);
      const out: SnapshotBall[] = [];
      for (let k = 0; k < cnt; k++) {
        const ba = a.balls[k];
        const bb = b.balls[k];
        if (ba && bb) {
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

    // No future snapshot yet (jitter burst / stall): extrapolate the base ball
    // along its velocity instead of holding it still.
    const dtSec =
      Math.max(0, Math.min(MAX_BALL_EXTRAP_MS, renderTime - a.t)) / 1000;
    return a.balls.map((bb) =>
      dtSec > 0
        ? { ...bb, x: bb.x + bb.vx * dtSec, y: bb.y + bb.vy * dtSec }
        : bb,
    );
  }
}
