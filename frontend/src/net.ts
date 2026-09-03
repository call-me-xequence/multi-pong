// net.ts — WebSocket connection wrapper with latency measurement and reconnect.

import type { ClientMessage, ServerMessage, Snapshot, WelcomeMessage } from './types.js';

export interface NetHandlers {
  onWelcome: (w: WelcomeMessage) => void;
  onSnapshot: (s: Snapshot) => void;
  onError: (msg: string) => void;
  onKicked: () => void;
  onClose: () => void;
}

export class Net {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private latencyMs = 60;
  private closedByUser = false;

  constructor(
    private roomID: string,
    private playerName: string,
    private password: string,
    private handlers: NetHandlers,
  ) {}

  connect(): void {
    this.closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url =
      `${proto}://${location.host}/ws` +
      `?roomID=${encodeURIComponent(this.roomID)}` +
      `&playerName=${encodeURIComponent(this.playerName)}` +
      `&password=${encodeURIComponent(this.password)}`;

    this.ws = new WebSocket(url);

    this.ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      switch (m.type) {
        case 'welcome':
          this.handlers.onWelcome(m);
          break;
        case 'snapshot':
          this.handlers.onSnapshot(m);
          break;
        case 'error':
          this.handlers.onError(m.message);
          break;
        case 'pong': {
          const rtt = performance.now() - m.c;
          this.latencyMs = Math.max(30, Math.min(220, rtt / 2));
          break;
        }
        case 'kicked':
          this.handlers.onKicked();
          break;
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (!this.closedByUser) this.handlers.onClose();
    };

    this.ws.onerror = () => {
      /* onclose fires next */
    };

    this.send({ action: 'ping', c: performance.now() });
    this.pingTimer = window.setInterval(() => {
      this.send({ action: 'ping', c: performance.now() });
    }, 3000);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  getLatency(): number {
    return this.latencyMs;
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
