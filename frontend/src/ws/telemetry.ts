import { Emitter } from '../lib/emitter';
import type { SessionManager } from '../session';
import type { TelescopeState } from '../types';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface TelemetryEvents {
  telemetry: TelescopeState;
  status: WsStatus;
}

const HEARTBEAT_MS = 20_000;
const BACKOFF_MAX = 16_000;

export class TelemetryWs extends Emitter<TelemetryEvents> {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private heartbeatTimer: number | undefined;

  constructor(private readonly session: SessionManager) {
    super();
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    this.emit('status', 'connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws/telemetry`);

    this.ws.onopen = () => {
      this.backoff = 1000;
      this.emit('status', 'connected');
      this.startHeartbeat();
    };

    this.ws.onclose = () => {
      this.emit('status', 'disconnected');
      this.stopHeartbeat();
      window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    };

    this.ws.onerror = () => { /* surfaced via onclose */ };

    this.ws.onmessage = (evt) => {
      try {
        this.emit('telemetry', JSON.parse(evt.data) as TelescopeState);
      } catch { /* ignore malformed frames */ }
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const payload = this.session.heartbeatPayload();
      if (payload) this.ws.send(payload);
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
