import type { Api } from '../api';
import { ApiError } from '../api';
import { h } from '../lib/dom';
import { formatFreq, formatGain, formatRate } from '../lib/format';
import type { SessionManager } from '../session';
import type { Toaster } from '../toast';
import type { Axis, Direction, SDRStatus, TelescopeState } from '../types';

const SDR_POLL_MS = 5_000;

interface ArrowSpec { axis: Axis; direction: Direction; label: string; aria: string; }

const ARROWS: Record<Axis, ArrowSpec[]> = {
  azimuth: [
    { axis: 'azimuth',   direction: 'reverse', label: '◀  W', aria: 'Slew west' },
    { axis: 'azimuth',   direction: 'forward', label: 'E  ▶', aria: 'Slew east' },
  ],
  elevation: [
    { axis: 'elevation', direction: 'forward', label: '▲ Up',   aria: 'Slew up' },
    { axis: 'elevation', direction: 'reverse', label: '▼ Down', aria: 'Slew down' },
  ],
};

/** "Control" view — SDR start/stop, live status, slew pad. */
export class ControlView {
  readonly element: HTMLElement;
  private readonly sdrValues: Record<string, HTMLSpanElement>;
  private readonly sdrBadge: HTMLSpanElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly speedInput: HTMLInputElement;
  private readonly speedDisplay: HTMLSpanElement;
  private readonly motorBadges: Record<Axis, HTMLSpanElement>;
  private readonly activeAxes = new Set<Axis>();
  private pollTimer: number | undefined;

  constructor(private readonly api: Api, private readonly session: SessionManager, private readonly toaster: Toaster) {
    this.sdrBadge = h('span', { class: 'pill' }, 'Unknown');
    this.sdrValues = {
      freq:  h('span', { class: 'info-value' }, '—'),
      rate:  h('span', { class: 'info-value' }, '—'),
      gain:  h('span', { class: 'info-value' }, '—'),
      fft:   h('span', { class: 'info-value' }, '—'),
      intc:  h('span', { class: 'info-value' }, '—'),
    };

    this.startBtn = h('button', {
      class: 'btn btn-primary',
      onclick: () => this.startSdr(),
    }, [h('span', { class: 'btn-icon' }, '▶'), 'Start Observing']) as HTMLButtonElement;

    this.stopBtn = h('button', {
      class: 'btn btn-secondary',
      onclick: () => this.stopSdr(),
    }, [h('span', { class: 'btn-icon' }, '■'), 'Stop SDR']) as HTMLButtonElement;

    const sdrCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-header' }, [
        h('div', { class: 'card-title-group' }, [
          h('h2', { class: 'card-title' }, 'SDR Receiver'),
          h('span', { class: 'card-subtitle' }, 'Spectrum acquisition control'),
        ]),
        h('div', { class: 'card-actions' }, [this.startBtn, this.stopBtn]),
      ]),
      h('div', { class: 'info-grid' }, [
        infoItem('Status', this.sdrBadge),
        infoItem('Center Freq', this.sdrValues.freq!),
        infoItem('Sample Rate', this.sdrValues.rate!),
        infoItem('Gain', this.sdrValues.gain!),
        infoItem('FFT Size', this.sdrValues.fft!),
        infoItem('Integration', this.sdrValues.intc!),
      ]),
    ]);

    this.speedInput = h('input', {
      class: 'slider',
      type: 'range',
      min: '5', max: '100', step: '5',
      value: '40',
      oninput: () => { this.speedDisplay.textContent = `${this.speedInput.value}%`; },
    }) as HTMLInputElement;
    this.speedDisplay = h('span', { class: 'slider-value' }, '40%');

    this.motorBadges = {
      azimuth: h('span', { class: 'pill pill-muted' }, 'stopped'),
      elevation: h('span', { class: 'pill pill-muted' }, 'stopped'),
    };

    const slewCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-header' }, [
        h('div', { class: 'card-title-group' }, [
          h('h2', { class: 'card-title' }, 'Telescope Slew'),
          h('span', { class: 'card-subtitle' }, 'Hold button to move · release to stop'),
        ]),
        h('div', { class: 'card-actions' }, [
          h('div', { class: 'slider-group' }, [
            h('label', { class: 'slider-label' }, 'Speed'),
            this.speedInput,
            this.speedDisplay,
          ]),
        ]),
      ]),
      h('div', { class: 'slew-pad' }, [
        this.axisGroup('Azimuth', this.motorBadges.azimuth, ARROWS.azimuth, 'horizontal'),
        h('div', { class: 'slew-divider' }),
        this.axisGroup('Elevation', this.motorBadges.elevation, ARROWS.elevation, 'vertical'),
      ]),
    ]);

    this.element = h('div', { class: 'view view-control' }, [sdrCard, slewCard]);
  }

  show(): void {
    this.element.hidden = false;
    this.refreshSdr();
    this.pollTimer = window.setInterval(() => this.refreshSdr(), SDR_POLL_MS);
  }

  hide(): void {
    this.element.hidden = true;
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  onTelemetry(ts: TelescopeState): void {
    for (const axis of ['azimuth', 'elevation'] as const) {
      const motor = ts.motors[axis];
      const badge = this.motorBadges[axis];
      if (!motor) continue;
      if (motor.is_moving) {
        badge.textContent = `${motor.direction} · ${motor.duty}%`;
        badge.className = 'pill pill-active';
      } else {
        badge.textContent = 'stopped';
        badge.className = 'pill pill-muted';
      }
    }
  }

  async stopAll(): Promise<void> {
    this.activeAxes.clear();
    this.element.querySelectorAll('.btn-arrow').forEach(b => b.classList.remove('pressed'));
    try {
      await this.api.stop({});
    } catch { /* ignore */ }
  }

  private async refreshSdr(): Promise<void> {
    try {
      const s = await this.api.sdrStatus();
      this.applySdr(s);
    } catch { /* ignore transient */ }
  }

  private applySdr(s: SDRStatus): void {
    const running = s.running;
    this.sdrBadge.textContent = running ? 'Running' : 'Stopped';
    this.sdrBadge.className = `pill ${running ? 'pill-active' : 'pill-muted'}`;
    this.sdrValues.freq!.textContent = formatFreq(s.center_freq_hz);
    this.sdrValues.rate!.textContent = formatRate(s.sample_rate_hz);
    this.sdrValues.gain!.textContent = formatGain(s.gain);
    this.sdrValues.fft!.textContent = String(s.fft_size);
    this.sdrValues.intc!.textContent = `${s.integration_count} frames`;
    this.startBtn.disabled = running;
    this.stopBtn.disabled = !running;
  }

  private async startSdr(): Promise<void> {
    if (!(await this.session.ensure())) return;
    this.setBusy(this.startBtn, true);
    try {
      await this.api.sdrStart();
      this.toaster.show('SDR started', 'success');
      await this.refreshSdr();
    } catch (err) {
      this.toaster.show(`SDR start failed: ${errMsg(err)}`, 'error');
    } finally {
      this.setBusy(this.startBtn, false);
    }
  }

  private async stopSdr(): Promise<void> {
    if (!this.session.hasToken) return;
    this.setBusy(this.stopBtn, true);
    try {
      await this.api.sdrStop();
      this.toaster.show('SDR stopped', 'info');
      await this.refreshSdr();
    } catch (err) {
      this.toaster.show(`SDR stop failed: ${errMsg(err)}`, 'error');
    } finally {
      this.setBusy(this.stopBtn, false);
    }
  }

  private axisGroup(
    label: string,
    badge: HTMLSpanElement,
    arrows: ArrowSpec[],
    orientation: 'horizontal' | 'vertical',
  ): HTMLElement {
    const buttons = arrows.map(a => this.arrowButton(a));
    return h('div', { class: 'axis-group' }, [
      h('div', { class: 'axis-label' }, label),
      h('div', { class: `arrow-pair arrow-${orientation}` }, buttons),
      badge,
    ]);
  }

  private arrowButton(spec: ArrowSpec): HTMLButtonElement {
    const btn = h('button', {
      class: 'btn btn-arrow',
      'aria-label': spec.aria,
      dataset: { axis: spec.axis, direction: spec.direction },
    }, spec.label) as HTMLButtonElement;

    const start = async (e: PointerEvent) => {
      e.preventDefault();
      if (this.activeAxes.has(spec.axis)) return;
      if (!(await this.session.ensure())) return;
      btn.classList.add('pressed');
      this.activeAxes.add(spec.axis);
      try {
        await this.api.move({
          axis: spec.axis,
          direction: spec.direction,
          speed: parseInt(this.speedInput.value, 10),
        });
      } catch (err) {
        this.activeAxes.delete(spec.axis);
        btn.classList.remove('pressed');
        if (err instanceof ApiError && err.status === 403) this.session.revokeLocal();
        this.toaster.show(errMsg(err), 'error');
      }
    };

    const stop = async (e: PointerEvent) => {
      e.preventDefault();
      if (!this.activeAxes.has(spec.axis)) return;
      btn.classList.remove('pressed');
      this.activeAxes.delete(spec.axis);
      try {
        await this.api.stop({ axis: spec.axis });
      } catch { /* ignore */ }
    };

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('contextmenu', e => e.preventDefault());
    return btn;
  }

  private setBusy(btn: HTMLButtonElement, busy: boolean): void {
    btn.disabled = busy;
    btn.classList.toggle('loading', busy);
  }
}

function infoItem(label: string, valueEl: HTMLElement): HTMLElement {
  return h('div', { class: 'info-item' }, [
    h('div', { class: 'info-label' }, label),
    valueEl,
  ]);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
