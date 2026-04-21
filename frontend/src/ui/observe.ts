import type { Api } from '../api';
import { h } from '../lib/dom';
import { formatUptime } from '../lib/format';
import type { SessionManager } from '../session';
import type { Toaster } from '../toast';
import type { SpectrumFrame, TelescopeState } from '../types';
import { SpectrumCanvas } from './spectrum-canvas';

const WINDOW_OPTIONS: { value: number; label: string }[] = [
  { value: 10, label: '10 s' },
  { value: 30, label: '30 s' },
  { value: 60, label: '60 s' },
  { value: 120, label: '120 s' },
  { value: 300, label: '300 s' },
];

/** "Observe" view — live spectrum + telemetry readouts. */
export class ObserveView {
  readonly element: HTMLElement;
  private readonly canvas: SpectrumCanvas;
  private readonly windowSelect: HTMLSelectElement;
  private readonly intElapsed: HTMLSpanElement;
  private readonly intWindow: HTMLSpanElement;
  private readonly intFrames: HTMLSpanElement;
  private readonly intFill: HTMLDivElement;
  private readonly telemCells: Record<string, HTMLSpanElement>;
  private readonly safetyBadge: HTMLSpanElement;
  private readonly safetyReset: HTMLButtonElement;

  constructor(private readonly api: Api, private readonly session: SessionManager, private readonly toaster: Toaster) {
    this.canvas = new SpectrumCanvas();

    this.windowSelect = h('select', {
      class: 'input-select',
      onchange: () => this.onWindowChange(),
    }, WINDOW_OPTIONS.map(o => h('option', { value: String(o.value), selected: o.value === 30 }, o.label))) as HTMLSelectElement;

    this.intElapsed = h('span', { class: 'metric' }, '0.0');
    this.intWindow = h('span', { class: 'metric' }, '30');
    this.intFrames = h('span', { class: 'metric muted' }, '0');
    this.intFill = h('div', { class: 'integration-fill' });

    const resetWindowBtn = h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => this.resetIntegration(),
    }, 'Reset');

    const spectrumCard = h('section', { class: 'card card-spectrum' }, [
      h('div', { class: 'card-header' }, [
        h('div', { class: 'card-title-group' }, [
          h('h2', { class: 'card-title' }, 'Live Spectrum'),
          h('span', { class: 'card-subtitle' }, 'Hydrogen line at 1420.405 MHz'),
        ]),
        h('div', { class: 'card-actions' }, [
          h('div', { class: 'legend' }, [
            h('span', { class: 'legend-item legend-instant' }, 'Instant'),
            h('span', { class: 'legend-item legend-rolling' }, 'Rolling avg'),
          ]),
          h('label', { class: 'labeled-select' }, [
            h('span', {}, 'Window'),
            this.windowSelect,
          ]),
          resetWindowBtn,
        ]),
      ]),
      h('div', { class: 'spectrum-body' }, [this.canvas.element]),
      h('div', { class: 'integration-row' }, [
        h('div', { class: 'integration-text' }, [
          'Integration ',
          this.intElapsed, ' s / ', this.intWindow, ' s ',
          h('span', { class: 'int-frames' }, ['(', this.intFrames, ' frames)']),
        ]),
        h('div', { class: 'integration-bar' }, [this.intFill]),
      ]),
    ]);

    this.telemCells = {
      voltage: h('span', { class: 'telem-value' }, '--'),
      current: h('span', { class: 'telem-value' }, '--'),
      power: h('span', { class: 'telem-value' }, '--'),
      uptime: h('span', { class: 'telem-value mono' }, '--:--:--'),
    };
    this.safetyBadge = h('span', { class: 'pill pill-ok' }, 'OK');
    this.safetyReset = h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => this.resetSafety(),
    }, 'Reset');

    const telemetryStrip = h('section', { class: 'telem-strip' }, [
      telemCell('Bus Voltage', this.telemCells.voltage, 'V'),
      telemCell('Current', this.telemCells.current, 'A'),
      telemCell('Power', this.telemCells.power, 'W'),
      telemCell('Uptime', this.telemCells.uptime),
      h('div', { class: 'telem-cell telem-safety' }, [
        h('div', { class: 'telem-label' }, 'Safety'),
        h('div', { class: 'telem-safety-body' }, [this.safetyBadge, this.safetyReset]),
      ]),
    ]);

    this.element = h('div', { class: 'view view-observe' }, [spectrumCard, telemetryStrip]);
  }

  show(): void { this.element.hidden = false; }
  hide(): void { this.element.hidden = true; }

  onFrame(frame: SpectrumFrame): void {
    this.canvas.draw(frame);
    const windowS = Number(this.windowSelect.value);
    const elapsed = Math.min(frame.integration_s ?? 0, windowS);
    this.intElapsed.textContent = elapsed.toFixed(1);
    this.intWindow.textContent = String(windowS);
    this.intFrames.textContent = String(frame.frame_count ?? 0);
    this.intFill.style.width = `${(elapsed / windowS) * 100}%`;
  }

  onTelemetry(ts: TelescopeState): void {
    const s = ts.sensor;
    if (s.available) {
      this.telemCells.voltage!.textContent = s.bus_voltage_v.toFixed(2);
      this.telemCells.current!.textContent = s.current_a.toFixed(3);
      this.telemCells.power!.textContent = s.power_w.toFixed(2);
    } else {
      this.telemCells.voltage!.textContent = '--';
      this.telemCells.current!.textContent = '--';
      this.telemCells.power!.textContent = '--';
    }
    this.telemCells.uptime!.textContent = formatUptime(ts.uptime_s);

    const tripped = ts.safety.overcurrent_tripped;
    const degraded = !s.available;
    this.safetyBadge.className = `pill ${tripped ? 'pill-danger' : degraded ? 'pill-warn' : 'pill-ok'}`;
    this.safetyBadge.textContent = tripped ? 'OVERCURRENT' : degraded ? 'DEGRADED' : 'OK';
  }

  private async onWindowChange(): Promise<void> {
    if (!(await this.session.ensure())) return;
    const windowS = Number(this.windowSelect.value);
    this.intWindow.textContent = String(windowS);
    try {
      await this.api.sdrSetIntegrationWindow(windowS);
    } catch (err) {
      this.toaster.show(`Failed to set window: ${errMsg(err)}`, 'error');
    }
  }

  private async resetIntegration(): Promise<void> {
    if (!(await this.session.ensure())) return;
    const windowS = Number(this.windowSelect.value);
    try {
      await this.api.sdrSetIntegrationWindow(windowS);
      this.toaster.show('Integration reset', 'info');
    } catch (err) {
      this.toaster.show(`Reset failed: ${errMsg(err)}`, 'error');
    }
  }

  private async resetSafety(): Promise<void> {
    if (!(await this.session.ensure())) return;
    try {
      await this.api.safetyReset();
      this.toaster.show('Safety reset', 'success');
    } catch (err) {
      this.toaster.show(`Safety reset failed: ${errMsg(err)}`, 'error');
    }
  }
}

function telemCell(label: string, valueEl: HTMLElement, unit?: string): HTMLElement {
  return h('div', { class: 'telem-cell' }, [
    h('div', { class: 'telem-label' }, label),
    h('div', { class: 'telem-value-row' }, [
      valueEl,
      unit ? h('span', { class: 'telem-unit' }, unit) : null,
    ]),
  ]);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
