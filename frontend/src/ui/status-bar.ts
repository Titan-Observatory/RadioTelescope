import { h } from '../lib/dom';

export class StatusBar {
  readonly element: HTMLElement;
  private readonly wsEl: HTMLSpanElement;
  private readonly frameEl: HTMLSpanElement;
  private readonly sessionEl: HTMLSpanElement;

  constructor() {
    this.wsEl = h('span', { class: 'status-item' }, 'WebSocket: connecting…');
    this.frameEl = h('span', { class: 'status-item' }, 'No spectrum data');
    this.sessionEl = h('span', { class: 'status-item' }, 'Session: none');
    this.element = h('footer', { class: 'status-bar' }, [
      this.wsEl,
      h('span', { class: 'status-sep' }, '·'),
      this.frameEl,
      h('span', { class: 'status-sep' }, '·'),
      this.sessionEl,
    ]);
  }

  setWs(status: 'connecting' | 'connected' | 'disconnected'): void {
    const label = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting…' : 'reconnecting…';
    this.wsEl.textContent = `WebSocket: ${label}`;
  }

  setFrameAge(ageS: number | null): void {
    this.frameEl.textContent = ageS == null ? 'No spectrum data' : `Last frame: ${ageS.toFixed(1)}s ago`;
  }

  setSession(label: string): void {
    this.sessionEl.textContent = `Session: ${label}`;
  }
}
