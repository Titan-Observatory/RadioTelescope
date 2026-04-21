import type { Api } from '../api';
import { h } from '../lib/dom';
import type { SessionManager } from '../session';
import type { Toaster } from '../toast';
import type { AppConfigDump } from '../types';

type InputMap = Record<string, HTMLInputElement | HTMLSelectElement>;

/** "Configure" view — server-backed config with per-section Apply. */
export class ConfigureView {
  readonly element: HTMLElement;
  private readonly inputs: InputMap = {};
  private readonly applyButtons: { sdr: HTMLButtonElement; safety: HTMLButtonElement; motors: HTMLButtonElement };
  private readonly reloadBtn: HTMLButtonElement;

  constructor(private readonly api: Api, private readonly session: SessionManager, private readonly toaster: Toaster) {
    this.applyButtons = {
      sdr: this.applyBtn(() => this.applySdr()),
      safety: this.applyBtn(() => this.applySafety()),
      motors: this.applyBtn(() => this.applyMotors()),
    };

    this.reloadBtn = h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => this.reload(),
      title: 'Discard any edits and load current values from server',
    }, [h('span', {}, '↻'), 'Reload from server']) as HTMLButtonElement;

    this.element = h('div', { class: 'view view-configure' }, [
      h('div', { class: 'configure-header' }, [
        h('div', {}, [
          h('h1', { class: 'view-title' }, 'Configuration'),
          h('p', { class: 'view-subtitle' }, 'Changes take effect immediately. FFT & integration changes require restarting the SDR.'),
        ]),
        this.reloadBtn,
      ]),
      this.sdrSection(),
      this.safetySection(),
      this.motorSection(),
    ]);
  }

  show(): void {
    this.element.hidden = false;
    this.reload();
  }

  hide(): void { this.element.hidden = true; }

  async reload(): Promise<void> {
    try {
      const cfg = await this.api.getConfig();
      this.populate(cfg);
    } catch (err) {
      this.toaster.show(`Failed to load config: ${errMsg(err)}`, 'error');
    }
  }

  private populate(cfg: AppConfigDump): void {
    this.setInput('sdr-freq', (cfg.sdr.center_freq_hz / 1e6).toFixed(3));
    this.setInput('sdr-gain', String(cfg.sdr.gain));
    this.setInput('sdr-rate', String(cfg.sdr.sample_rate_hz));
    this.setInput('sdr-fft', String(cfg.sdr.fft_size));
    this.setInput('sdr-int', String(cfg.sdr.integration_count));

    this.setInput('saf-thresh', String(cfg.safety.overcurrent_threshold_a));
    this.setInput('saf-hold', String(cfg.safety.overcurrent_holdoff_s));
    this.setInput('saf-az-min', String(cfg.safety.azimuth_min_deg));
    this.setInput('saf-az-max', String(cfg.safety.azimuth_max_deg));
    this.setInput('saf-el-min', String(cfg.safety.elevation_min_deg));
    this.setInput('saf-el-max', String(cfg.safety.elevation_max_deg));

    this.setInput('mot-az-duty', String(cfg.motors.azimuth.max_duty));
    this.setInput('mot-az-ramp', String(cfg.motors.azimuth.ramp_time_s));
    this.setInput('mot-el-duty', String(cfg.motors.elevation.max_duty));
    this.setInput('mot-el-ramp', String(cfg.motors.elevation.ramp_time_s));
  }

  private async applySdr(): Promise<void> {
    if (!(await this.session.ensure())) return;
    const gainRaw = this.val('sdr-gain').trim();
    const gain: number | 'auto' = gainRaw === '' || gainRaw.toLowerCase() === 'auto' ? 'auto' : parseFloat(gainRaw);
    const body = {
      center_freq_hz: Math.round(parseFloat(this.val('sdr-freq')) * 1e6),
      sample_rate_hz: parseInt(this.val('sdr-rate'), 10),
      gain,
      fft_size: parseInt(this.val('sdr-fft'), 10),
      integration_count: parseInt(this.val('sdr-int'), 10),
    };
    await this.runApply(this.applyButtons.sdr, async () => {
      const res = await this.api.patchSdr(body);
      const note = res.needs_restart ? ' — restart SDR for FFT/integration changes' : '';
      this.toaster.show(`SDR settings applied${note}`, 'success');
    });
  }

  private async applySafety(): Promise<void> {
    if (!(await this.session.ensure())) return;
    const body = {
      overcurrent_threshold_a: parseFloat(this.val('saf-thresh')),
      overcurrent_holdoff_s: parseFloat(this.val('saf-hold')),
      azimuth_min_deg: parseFloat(this.val('saf-az-min')),
      azimuth_max_deg: parseFloat(this.val('saf-az-max')),
      elevation_min_deg: parseFloat(this.val('saf-el-min')),
      elevation_max_deg: parseFloat(this.val('saf-el-max')),
    };
    await this.runApply(this.applyButtons.safety, async () => {
      await this.api.patchSafety(body);
      this.toaster.show('Safety settings applied', 'success');
    });
  }

  private async applyMotors(): Promise<void> {
    if (!(await this.session.ensure())) return;
    await this.runApply(this.applyButtons.motors, async () => {
      await Promise.all([
        this.api.patchMotor('azimuth', {
          max_duty: parseInt(this.val('mot-az-duty'), 10),
          ramp_time_s: parseFloat(this.val('mot-az-ramp')),
        }),
        this.api.patchMotor('elevation', {
          max_duty: parseInt(this.val('mot-el-duty'), 10),
          ramp_time_s: parseFloat(this.val('mot-el-ramp')),
        }),
      ]);
      this.toaster.show('Motor settings applied', 'success');
    });
  }

  private async runApply(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      await fn();
    } catch (err) {
      this.toaster.show(`Failed: ${errMsg(err)}`, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  }

  // ── Form sections ──────────────────────────────────────────────────────────

  private sdrSection(): HTMLElement {
    return this.sectionCard('SDR Settings', 'Radio tuning & spectrum processing', [
      field('Center Frequency (MHz)', this.num('sdr-freq', { step: '0.001', min: '24', max: '1766' })),
      field('Gain', this.text('sdr-gain', { placeholder: 'auto or numeric dB' })),
      field('Sample Rate (Hz)', this.num('sdr-rate', { step: '1', min: '225001', max: '3200000' })),
      field('FFT Size', this.select('sdr-fft', ['512', '1024', '2048', '4096'])),
      field('Integration Frames', this.num('sdr-int', { min: '1', max: '64' })),
    ], this.applyButtons.sdr);
  }

  private safetySection(): HTMLElement {
    return this.sectionCard('Safety Settings', 'Current limits & travel stops', [
      field('Overcurrent Threshold (A)', this.num('saf-thresh', { step: '0.1', min: '0.1', max: '20' })),
      field('Overcurrent Holdoff (s)', this.num('saf-hold', { step: '0.05', min: '0', max: '10' })),
      field('Azimuth Min (°)', this.num('saf-az-min', { min: '-360', max: '360' })),
      field('Azimuth Max (°)', this.num('saf-az-max', { min: '-360', max: '360' })),
      field('Elevation Min (°)', this.num('saf-el-min', { min: '-90', max: '90' })),
      field('Elevation Max (°)', this.num('saf-el-max', { min: '-90', max: '90' })),
    ], this.applyButtons.safety);
  }

  private motorSection(): HTMLElement {
    const azGrid = h('div', { class: 'form-grid' }, [
      field('Max Duty (%)', this.num('mot-az-duty', { min: '1', max: '100' })),
      field('Ramp Time (s, 0→100%)', this.num('mot-az-ramp', { step: '0.1', min: '0.1', max: '30' })),
    ]);
    const elGrid = h('div', { class: 'form-grid' }, [
      field('Max Duty (%)', this.num('mot-el-duty', { min: '1', max: '100' })),
      field('Ramp Time (s, 0→100%)', this.num('mot-el-ramp', { step: '0.1', min: '0.1', max: '30' })),
    ]);
    return h('section', { class: 'card card-configure' }, [
      h('div', { class: 'card-header' }, [
        h('div', { class: 'card-title-group' }, [
          h('h2', { class: 'card-title' }, 'Motor Settings'),
          h('span', { class: 'card-subtitle' }, 'PWM duty & acceleration'),
        ]),
      ]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'subheading' }, 'Azimuth'),
        azGrid,
        h('div', { class: 'subheading' }, 'Elevation'),
        elGrid,
        h('div', { class: 'form-actions' }, [this.applyButtons.motors]),
      ]),
    ]);
  }

  private sectionCard(title: string, subtitle: string, fields: HTMLElement[], applyBtn: HTMLButtonElement): HTMLElement {
    return h('section', { class: 'card card-configure' }, [
      h('div', { class: 'card-header' }, [
        h('div', { class: 'card-title-group' }, [
          h('h2', { class: 'card-title' }, title),
          h('span', { class: 'card-subtitle' }, subtitle),
        ]),
      ]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'form-grid' }, fields),
        h('div', { class: 'form-actions' }, [applyBtn]),
      ]),
    ]);
  }

  // ── Input helpers ──────────────────────────────────────────────────────────

  private num(key: string, attrs: Record<string, string> = {}): HTMLInputElement {
    const el = h('input', { class: 'input', type: 'number', ...attrs }) as HTMLInputElement;
    this.inputs[key] = el;
    return el;
  }

  private text(key: string, attrs: Record<string, string> = {}): HTMLInputElement {
    const el = h('input', { class: 'input', type: 'text', ...attrs }) as HTMLInputElement;
    this.inputs[key] = el;
    return el;
  }

  private select(key: string, options: string[]): HTMLSelectElement {
    const el = h('select', { class: 'input input-select' }, options.map(o => h('option', { value: o }, o))) as HTMLSelectElement;
    this.inputs[key] = el;
    return el;
  }

  private applyBtn(onClick: () => void): HTMLButtonElement {
    return h('button', { class: 'btn btn-primary', onclick: onClick }, 'Apply') as HTMLButtonElement;
  }

  private setInput(key: string, value: string): void {
    const el = this.inputs[key];
    if (el) el.value = value;
  }

  private val(key: string): string {
    const el = this.inputs[key];
    return el ? el.value : '';
  }
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, [
    h('span', { class: 'field-label' }, label),
    input,
  ]);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
