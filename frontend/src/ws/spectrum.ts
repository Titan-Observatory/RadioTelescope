import { Emitter } from '../lib/emitter';
import type { SpectrumFrame } from '../types';

interface SpectrumEvents {
  frame: SpectrumFrame;
  disconnected: void;
}

const BACKOFF_MAX = 16_000;

export class SpectrumWs extends Emitter<SpectrumEvents> {
  private ws: WebSocket | null = null;
  private backoff = 1000;

  start(): void { this.connect(); }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws/spectrum`);

    this.ws.onopen = () => { this.backoff = 1000; };
    this.ws.onerror = () => { /* surfaced via onclose */ };

    this.ws.onclose = () => {
      this.emit('disconnected', undefined);
      window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    };

    this.ws.onmessage = (evt) => {
      try {
        this.emit('frame', JSON.parse(evt.data) as SpectrumFrame);
      } catch { /* ignore */ }
    };
  }
}
