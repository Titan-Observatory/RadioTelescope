import { h } from '../lib/dom';
import type { SessionManager, SessionState } from '../session';
import type { SafetyStatus, SensorReading } from '../types';

export type SafetyLevel = 'ok' | 'degraded' | 'tripped';

export class Header {
  readonly element: HTMLElement;
  private readonly wsDot: HTMLSpanElement;
  private readonly wsLabel: HTMLSpanElement;
  private readonly safetyPill: HTMLSpanElement;
  private readonly sessionBadge: HTMLButtonElement;

  constructor(session: SessionManager, onStopAll: () => void) {
    this.wsDot = h('span', { class: 'ws-dot', title: 'WebSocket disconnected' });
    this.wsLabel = h('span', { class: 'ws-label' }, 'connecting…');
    this.safetyPill = h('span', { class: 'safety-pill ok' }, '● OK');
    this.sessionBadge = h('button', {
      class: 'session-badge',
      title: 'Click to take control',
      onclick: async () => {
        if (session.hasToken) await session.release();
        else await session.claim();
      },
    }, 'Not in control');

    session.on('change', (s) => this.updateSession(s));

    this.element = h('header', { class: 'app-header' }, [
      h('div', { class: 'app-header-left' }, [
        h('div', { class: 'app-brand' }, [
          h('div', { class: 'app-logo' }, '◉'),
          h('div', { class: 'app-brand-text' }, [
            h('div', { class: 'app-title' }, 'Radio Telescope'),
            h('div', { class: 'app-subtitle' }, 'H I · 1420.405 MHz'),
          ]),
        ]),
      ]),
      h('div', { class: 'app-header-center' }, [
        h('div', { class: 'ws-indicator', title: 'WebSocket status' }, [this.wsDot, this.wsLabel]),
      ]),
      h('div', { class: 'app-header-right' }, [
        this.safetyPill,
        this.sessionBadge,
        h('button', {
          class: 'btn btn-danger btn-stop',
          title: 'Emergency stop (Esc)',
          onclick: onStopAll,
        }, [h('span', { class: 'stop-icon' }, '■'), 'STOP ALL']),
      ]),
    ]);
  }

  setWsStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    this.wsDot.className = `ws-dot ws-${status}`;
    this.wsDot.title = `WebSocket ${status}`;
    this.wsLabel.textContent =
      status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting…' : 'reconnecting…';
  }

  setSafety(level: SafetyLevel): void {
    const text = level === 'ok' ? 'OK' : level === 'degraded' ? 'DEGRADED' : 'TRIPPED';
    this.safetyPill.className = `safety-pill ${level}`;
    this.safetyPill.textContent = `● ${text}`;
  }

  applyTelemetry(sensor: SensorReading, safety: SafetyStatus): void {
    if (safety.overcurrent_tripped) this.setSafety('tripped');
    else if (!sensor.available) this.setSafety('degraded');
    else this.setSafety('ok');
  }

  private updateSession(s: SessionState): void {
    this.sessionBadge.classList.remove('in-control', 'other-control');
    if (s.kind === 'in-control') {
      this.sessionBadge.textContent = 'In Control';
      this.sessionBadge.classList.add('in-control');
      this.sessionBadge.title = 'Click to release control';
    } else if (s.kind === 'other-control') {
      this.sessionBadge.textContent = 'Other User';
      this.sessionBadge.classList.add('other-control');
      this.sessionBadge.title = 'Another user has control';
    } else {
      this.sessionBadge.textContent = 'Take Control';
      this.sessionBadge.title = 'Click to take control';
    }
  }
}
