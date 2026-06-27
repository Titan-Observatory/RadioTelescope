import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { displayWindow } from './spectrum';
import { PLOT_LEFT_PX, PLOT_RIGHT_PX } from './spectrumChartOptions';
import type { SpectrumFrame } from './spectrumTypes';

// How tall each new waterfall row is, in CSS pixels. The render multiplies
// this by devicePixelRatio. 1 CSS px at 10 Hz would creep at 10 px/sec — too
// slow for the eye to feel "live". 3 CSS px gives ~30 px/sec, filling a
// 250 px canvas in about eight seconds, which feels responsive without
// turning the trace into a smeared blur.
const WATERFALL_ROW_PX = 3;

// Inferno-style colormap stops. Low power fades to deep purple-black so the
// panel background reads as "no signal"; high power blooms through magenta/
// orange into a hot yellow-white that pops against the dark UI. Pre-expanded
// to a 256-entry LUT below for one-lookup-per-pixel rendering.
const WATERFALL_STOPS: Array<[number, number, number]> = [
  [0x04, 0x02, 0x0a],
  [0x1b, 0x0b, 0x3b],
  [0x42, 0x0a, 0x68],
  [0x6a, 0x17, 0x6e],
  [0x93, 0x26, 0x67],
  [0xbc, 0x37, 0x54],
  [0xdd, 0x51, 0x3a],
  [0xf3, 0x77, 0x1a],
  [0xfb, 0xa4, 0x0a],
  [0xfc, 0xff, 0xa4],
];

function buildColormapLUT(
  stops: Array<[number, number, number]>,
  size: number,
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 4);
  const segments = stops.length - 1;
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    const f = t * segments;
    const a = Math.min(segments, Math.floor(f));
    const b = Math.min(segments, a + 1);
    const local = f - a;
    const s0 = stops[a];
    const s1 = stops[b];
    lut[i * 4]     = s0[0] + (s1[0] - s0[0]) * local;
    lut[i * 4 + 1] = s0[1] + (s1[1] - s0[1]) * local;
    lut[i * 4 + 2] = s0[2] + (s1[2] - s0[2]) * local;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

const WATERFALL_LUT: Uint8ClampedArray = buildColormapLUT(WATERFALL_STOPS, 256);

interface UseSpectrumWaterfallOptions {
  frame: SpectrumFrame | null;
  waterfallDisplayed: number[] | null;
  baselineApplies: boolean;
  // EMA-smoothed colour range, owned by SpectrumPanel and shared with the line
  // chart so the inferno palette stays in step with the trace's y-axis fit.
  waterfallRangeRef: MutableRefObject<[number, number]>;
}

// Renders the scrolling waterfall straight to a 2D canvas: each tick we scroll
// the existing pixels down one row with drawImage(self) and paint the newest
// spectrum across the top row. Far cheaper than rebuilding a heatmap dataset of
// tens of thousands of cells per frame.
export function useSpectrumWaterfall({
  frame,
  waterfallDisplayed,
  baselineApplies,
  waterfallRangeRef,
}: UseSpectrumWaterfallOptions) {
  const waterfallCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Signature of the current FFT layout. When the centre/sample-rate/bin count
  // or baseline correction toggles, the dB scale shifts wholesale, so we wipe
  // the canvas rather than render a mismatched colour-coded seam.
  const waterfallSigRef = useRef<string>('');
  // The last frame we actually painted. The draw effect also re-fires when
  // display scale changes; those must not duplicate a row — it just relabels
  // the colours we already drew (lossy, but cheap).
  const lastWaterfallFrameRef = useRef<SpectrumFrame | null>(null);
  const waterfallRowRef = useRef<ImageData | null>(null);

  // Clear the rolling history so a reconnect / stale-frame reset can't stitch
  // old rows onto a fresh stream.
  const resetWaterfall = useCallback(() => {
    lastWaterfallFrameRef.current = null;
    waterfallSigRef.current = '';
  }, []);

  // Keep the waterfall canvas pixel-buffer in lockstep with its CSS box,
  // scaled for devicePixelRatio so the inferno colours stay crisp on HiDPI.
  // Resizes clear the buffer — there's no clean way to rescale a waterfall
  // and pretending we can would just produce a smeared frame.
  useEffect(() => {
    const canvas = waterfallCanvasRef.current;
    if (!canvas) return;
    const sync = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        waterfallSigRef.current = ''; // force a clear+redraw on next frame
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Paint one new row at the top of the waterfall per incoming frame.
  useEffect(() => {
    const canvas = waterfallCanvasRef.current;
    if (!canvas || !frame || !waterfallDisplayed) return;

    // Only paint genuine new frames. yRange changes re-fire this effect but
    // shouldn't shove a duplicate row into the rolling history.
    if (lastWaterfallFrameRef.current === frame) return;
    lastWaterfallFrameRef.current = frame;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    const plotLeft = Math.round(PLOT_LEFT_PX * dpr);
    const plotRight = Math.round(PLOT_RIGHT_PX * dpr);
    const plotW = Math.max(1, w - plotLeft - plotRight);
    // Each frame moves the data down by rowH device pixels. The minimum of 1
    // keeps very small canvases from stalling out at 0 px/frame.
    const rowH = Math.max(1, Math.round(WATERFALL_ROW_PX * dpr));

    // Reset the canvas when the FFT layout or baseline state changes — the
    // colour scale jumps and stitching old rows onto new ones would lie
    // about what the receiver was seeing.
    const sig = [
      w, h,
      frame.freqs_mhz.length,
      frame.center_freq_mhz.toFixed(6),
      frame.sample_rate_mhz.toFixed(6),
      baselineApplies ? 'baseline' : 'raw',
    ].join('|');
    if (sig !== waterfallSigRef.current) {
      ctx.clearRect(0, 0, w, h);
      waterfallSigRef.current = sig;
    }

    // Scroll the existing pixels down by rowH device-pixel rows. Drawing the
    // canvas onto itself with a y-offset is the fastest way to do this — no
    // ImageData round-trip, GPU-friendly under accelerated 2D contexts.
    ctx.imageSmoothingEnabled = false;
    if (h > rowH) {
      ctx.drawImage(canvas, 0, 0, w, h - rowH, 0, rowH, w, h - rowH);
    }

    // Build the new top row directly in an ImageData buffer. Compute each
    // column's colour once and replicate it down rowH rows so the new band
    // is a solid stripe of constant colour per frequency.
    const [yMin, yMax] = waterfallRangeRef.current;
    const yScale = yMax > yMin ? 1 / (yMax - yMin) : 1;
    const bins = waterfallDisplayed.length;
    const binsMaxIdx = bins - 1;

    if (!waterfallRowRef.current ||
        waterfallRowRef.current.width !== plotW ||
        waterfallRowRef.current.height !== rowH) {
      waterfallRowRef.current = ctx.createImageData(plotW, rowH);
    }
    const row = waterfallRowRef.current;
    const rowData = row.data;
    const lut = WATERFALL_LUT;
    const lutMaxIdx = (lut.length / 4) - 1;
    const stride = plotW * 4;

    // Map each pixel column through the same x-axis window the line chart uses
    // so the waterfall stays frequency-aligned with the trace above it. Bins
    // are evenly spaced across [dataMin, dataMax]; a pixel's frequency is a
    // linear interpolation over the visible window, then back to a bin index.
    const win = displayWindow(frame);
    const xMin = win ? win.xMin : frame.freqs_mhz[0];
    const xMax = win ? win.xMax : frame.freqs_mhz[binsMaxIdx];
    const dataMin = win ? win.dataMin : frame.freqs_mhz[0];
    const dataMax = win ? win.dataMax : frame.freqs_mhz[binsMaxIdx];
    const freqSpan = dataMax - dataMin;

    for (let px = 0; px < plotW; px++) {
      const ratio = plotW === 1 ? 0 : px / (plotW - 1);
      const freq = xMin + ratio * (xMax - xMin);
      const binF = freqSpan > 0
        ? ((freq - dataMin) / freqSpan) * binsMaxIdx
        : ratio * binsMaxIdx;
      const i = Math.min(binsMaxIdx, Math.max(0, Math.floor(binF)));
      const t = binF - i;
      const a = waterfallDisplayed[i];
      const b = waterfallDisplayed[Math.min(binsMaxIdx, i + 1)];
      const v = a + (b - a) * t;
      let norm = (v - yMin) * yScale;
      if (norm < 0) norm = 0; else if (norm > 1) norm = 1;
      const li = (norm * lutMaxIdx) | 0;
      const off = li * 4;
      const r = lut[off];
      const g = lut[off + 1];
      const bl = lut[off + 2];
      // First row
      const base = px * 4;
      rowData[base]     = r;
      rowData[base + 1] = g;
      rowData[base + 2] = bl;
      rowData[base + 3] = 255;
      // Replicate down rowH-1 more rows for the same column
      for (let yy = 1; yy < rowH; yy++) {
        const off2 = base + yy * stride;
        rowData[off2]     = r;
        rowData[off2 + 1] = g;
        rowData[off2 + 2] = bl;
        rowData[off2 + 3] = 255;
      }
    }
    ctx.putImageData(row, plotLeft, 0);
  }, [frame, waterfallDisplayed, baselineApplies, waterfallRangeRef]);

  return { waterfallCanvasRef, resetWaterfall };
}
