import { h } from '../lib/dom';
import { decodeSpectrum } from '../lib/format';
import type { SpectrumFrame } from '../types';

const HI_FREQ_HZ = 1_420_405_000;
const PAD = { top: 18, right: 14, bottom: 30, left: 54 };

/** Spectrum plot. Draws instant (faint) + rolling average (primary) traces with a gradient fill. */
export class SpectrumCanvas {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hoverLabel: HTMLDivElement;
  private lastFrame: SpectrumFrame | null = null;
  private hoverX: number | null = null;
  private dpr = Math.max(1, window.devicePixelRatio || 1);

  constructor() {
    this.canvas = h('canvas', { class: 'spectrum-canvas' });
    this.hoverLabel = h('div', { class: 'spectrum-hover' });
    this.element = h('div', { class: 'spectrum-wrap' }, [this.canvas, this.hoverLabel]);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    new ResizeObserver(() => this.resize()).observe(this.element);
    this.canvas.addEventListener('pointermove', (e) => this.onPointer(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.hoverLabel.style.opacity = '0'; this.redraw(); });
    this.resize();
  }

  draw(frame: SpectrumFrame): void {
    this.lastFrame = frame;
    this.redraw();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.element;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.redraw();
  }

  private onPointer(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - rect.left;
    this.redraw();
  }

  private redraw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.clearRect(0, 0, w, h);

    if (!this.lastFrame) {
      this.drawEmpty(ctx, w, h);
      return;
    }

    const frame = this.lastFrame;
    const instant = decodeSpectrum(frame.magnitudes_b64);
    const rolling = decodeSpectrum(frame.rolling_b64);
    if (rolling.length === 0) return;

    const plot = { x: PAD.left, y: PAD.top, w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom };

    // Y range from rolling average
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const v of rolling) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
    if (!isFinite(yMin) || yMin === yMax) { yMin = -80; yMax = -20; }
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;

    const xScale = (i: number) => plot.x + (i / (rolling.length - 1)) * plot.w;
    const yScale = (v: number) => plot.y + plot.h - ((v - yMin) / (yMax - yMin)) * plot.h;

    this.drawGrid(ctx, plot, yMin, yMax, frame);
    this.drawHiLine(ctx, plot);
    this.drawInstant(ctx, instant, xScale, yScale);
    this.drawRolling(ctx, rolling, xScale, yScale, plot);

    if (this.hoverX != null && this.hoverX >= plot.x && this.hoverX <= plot.x + plot.w) {
      this.drawHover(ctx, plot, rolling, frame.bandwidth_hz, xScale, yScale);
    } else {
      this.hoverLabel.style.opacity = '0';
    }
  }

  private drawEmpty(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(180, 190, 220, 0.4)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SDR not running — start it from the Control panel', w / 2, h / 2);
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    plot: { x: number; y: number; w: number; h: number },
    yMin: number,
    yMax: number,
    frame: SpectrumFrame,
  ): void {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, "JetBrains Mono", Consolas, monospace';

    // Horizontal grid + y labels
    const ySteps = 5;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let s = 0; s <= ySteps; s++) {
      const v = yMin + (yMax - yMin) * (s / ySteps);
      const y = plot.y + plot.h - (s / ySteps) * plot.h;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(180, 190, 220, 0.5)';
      ctx.fillText(`${v.toFixed(0)} dB`, plot.x - 6, y);
    }

    // Vertical grid + frequency labels
    const bw = frame.bandwidth_hz;
    const offsets = [-1e6, -0.5e6, 0, 0.5e6, 1e6];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const off of offsets) {
      const frac = (off + bw / 2) / bw;
      if (frac < 0 || frac > 1) continue;
      const x = plot.x + frac * plot.w;
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(180, 190, 220, 0.5)';
      ctx.fillText(((HI_FREQ_HZ + off) / 1e6).toFixed(2), x, plot.y + plot.h + 8);
    }
    ctx.fillStyle = 'rgba(180, 190, 220, 0.35)';
    ctx.fillText('MHz', plot.x + plot.w / 2, plot.y + plot.h + 20);
  }

  private drawHiLine(ctx: CanvasRenderingContext2D, plot: { x: number; y: number; w: number; h: number }): void {
    const x = plot.x + plot.w / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    ctx.restore();
  }

  private drawInstant(
    ctx: CanvasRenderingContext2D,
    data: Float32Array,
    xScale: (i: number) => number,
    yScale: (v: number) => number,
  ): void {
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.38)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xScale(i);
      const y = yScale(data[i]!);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private drawRolling(
    ctx: CanvasRenderingContext2D,
    data: Float32Array,
    xScale: (i: number) => number,
    yScale: (v: number) => number,
    plot: { x: number; y: number; w: number; h: number },
  ): void {
    // Gradient fill under the trace
    const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    gradient.addColorStop(0, 'rgba(34, 211, 238, 0.30)');
    gradient.addColorStop(1, 'rgba(34, 211, 238, 0.00)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xScale(i);
      const y = yScale(data[i]!);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
    ctx.lineTo(plot.x, plot.y + plot.h);
    ctx.closePath();
    ctx.fill();

    // Trace line
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xScale(i);
      const y = yScale(data[i]!);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private drawHover(
    ctx: CanvasRenderingContext2D,
    plot: { x: number; y: number; w: number; h: number },
    rolling: Float32Array,
    bw: number,
    xScale: (i: number) => number,
    yScale: (v: number) => number,
  ): void {
    if (this.hoverX == null) return;
    const frac = (this.hoverX - plot.x) / plot.w;
    const idx = Math.max(0, Math.min(rolling.length - 1, Math.round(frac * (rolling.length - 1))));
    const value = rolling[idx]!;
    const freqHz = HI_FREQ_HZ + (frac - 0.5) * bw;

    const x = xScale(idx);
    const y = yScale(value);

    // Crosshair
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    ctx.restore();

    // Dot
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();

    // Label (HTML element — nicer text rendering than canvas)
    this.hoverLabel.textContent = `${(freqHz / 1e6).toFixed(3)} MHz · ${value.toFixed(1)} dB`;
    this.hoverLabel.style.opacity = '1';
    const labelOffset = 12;
    const elRect = this.element.getBoundingClientRect();
    const lw = this.hoverLabel.offsetWidth;
    let left = x + labelOffset;
    if (left + lw > elRect.width - 8) left = x - lw - labelOffset;
    this.hoverLabel.style.left = `${left}px`;
    this.hoverLabel.style.top = `${Math.max(4, y - 28)}px`;
  }
}
