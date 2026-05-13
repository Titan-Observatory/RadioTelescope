// Tree-shakable echarts import. Pulling from `echarts/core` plus only the
// pieces we actually use keeps the bundle small enough that Rollup doesn't
// OOM when building on the Raspberry Pi. Adding any new feature (e.g. a
// scatter overlay, a legend, dataZoom) requires registering the matching
// component here.
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

import { Camera, Eraser, FolderOpen, Maximize2, Radio, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

echarts.use([
  LineChart,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

// Plot-area insets for the spectrum line chart. The waterfall canvas uses the
// same values so its frequency axis lines up perfectly with the trace above.
const PLOT_LEFT_PX = 52;
const PLOT_RIGHT_PX = 18;

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

const WATERFALL_LUT: Uint8ClampedArray = buildColormapLUT(WATERFALL_STOPS, 256);

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

// 21 cm neutral-hydrogen line — the rolling integration is centred here.
const H1_REST_MHZ = 1420.4058;

// Default locked y-range, chosen so the median-subtracted trace fits a
// freshly-tuned RTL-SDR's typical noise floor without clipping. Hit "Fit Y"
// to recompute around what's actually on screen.
const DEFAULT_Y_RANGE: [number, number] = [-8, 8];

interface SpectrumFrame {
  timestamp: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  frames_seen: number;
  frame_duration_s: number;
  integration_seconds: number;
  mode: string;
  freqs_mhz: number[];
  power_db: number[];
}

interface SpectrumStatus {
  enabled: boolean;
  mode: string;
  center_freq_mhz?: number;
  sample_rate_mhz?: number;
  fft_size?: number;
  integration_frames?: number;
  publish_rate_hz?: number;
  latest_timestamp?: number | null;
  latest_frame_age_s?: number | null;
  latest_frames_seen?: number;
  subscriber_count?: number;
}

interface Baseline {
  captured_at: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  freqs_mhz: number[];
  power_db: number[];
}

export function SpectrumPanel() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  // The waterfall is rendered straight to a 2D canvas: each tick we scroll the
  // existing pixels down one row with drawImage(self) and paint the newest
  // spectrum across the top row. That's far cheaper than rebuilding a heatmap
  // dataset of tens of thousands of cells per frame.
  const waterfallCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Signature of the current FFT layout. When the centre/sample-rate/bin count
  // or baseline subtraction toggles, the dB scale shifts wholesale, so we wipe
  // the canvas rather than render a mismatched colour-coded seam.
  const waterfallSigRef = useRef<string>('');
  // The last frame we actually painted. The draw effect also re-fires when
  // yRange changes (Fit Y / Reset Y); a yRange-only change must not duplicate
  // a row — it just relabels the colours we already drew (lossy, but cheap).
  const lastWaterfallFrameRef = useRef<SpectrumFrame | null>(null);
  const [status, setStatus] = useState<SpectrumStatus | null>(null);
  const [frame, setFrame] = useState<SpectrumFrame | null>(null);
  const [connected, setConnected] = useState(false);
  const [yRange, setYRange] = useState<[number, number]>(DEFAULT_Y_RANGE);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Baseline subtraction is what makes the H I line pop above the bandpass.
  // Only apply when the cached baseline matches the current FFT layout —
  // otherwise the arrays don't align and the subtraction is nonsense.
  const baselineApplies = useMemo(() => {
    if (!baseline || !frame) return false;
    return (
      baseline.power_db.length === frame.power_db.length &&
      Math.abs(baseline.center_freq_mhz - frame.center_freq_mhz) < 1e-6 &&
      Math.abs(baseline.sample_rate_mhz - frame.sample_rate_mhz) < 1e-6
    );
  }, [baseline, frame]);

  const displayed = useMemo(() => {
    if (!frame) return null;
    if (baselineApplies && baseline) {
      return frame.power_db.map((v, i) => v - baseline.power_db[i]);
    }
    return frame.power_db;
  }, [frame, baseline, baselineApplies]);

  // Initialise the ECharts instance once. ResizeObserver keeps it sized
  // against the panel even as the dashboard grid reflows.
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    chartInstance.current = chart;
    chart.setOption(baseOption(DEFAULT_Y_RANGE));

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(chartRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartInstance.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch('/api/spectrum/status');
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const s = await r.json() as SpectrumStatus;
        if (cancelled) return;
        setStatus(s);
      } catch {
        if (cancelled) return;
        setStatus({ enabled: false, mode: 'unavailable' });
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // WebSocket subscription. Each frame is a fully-integrated spectrum from
  // the backend — we swap the series wholesale rather than appending.
  useEffect(() => {
    if (status && status.enabled === false) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/spectrum`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as SpectrumFrame;
        setFrame(next);
      } catch { /* ignore malformed frames */ }
    };
    return () => ws.close();
  }, [status?.enabled]);

  // Update the spectrum line chart on each new frame / range change.
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || !frame || !displayed) return;
    const data = frame.freqs_mhz.map((f, i) => [f, displayed[i]] as [number, number]);
    chart.setOption({
      yAxis: { min: yRange[0], max: yRange[1] },
      series: [{ data }],
    });
  }, [frame, displayed, yRange]);

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
    if (!canvas || !frame || !displayed) return;

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
    const yMin = yRange[0];
    const yMax = yRange[1];
    const yScale = yMax > yMin ? 1 / (yMax - yMin) : 1;
    const bins = displayed.length;
    const binsMaxIdx = bins - 1;

    const row = ctx.createImageData(plotW, rowH);
    const rowData = row.data;
    const lut = WATERFALL_LUT;
    const lutMaxIdx = (lut.length / 4) - 1;
    const stride = plotW * 4;

    for (let px = 0; px < plotW; px++) {
      const ratio = plotW === 1 ? 0 : px / (plotW - 1);
      const binF = ratio * binsMaxIdx;
      const i = Math.min(binsMaxIdx, Math.floor(binF));
      const t = binF - i;
      const a = displayed[i];
      const b = displayed[Math.min(binsMaxIdx, i + 1)];
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
  }, [frame, displayed, yRange, baselineApplies]);

  const fitY = useCallback(() => {
    if (!displayed || displayed.length === 0) return;
    let min = Infinity, max = -Infinity;
    for (const v of displayed) {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    const span = Math.max(max - min, 1);
    const pad = span * 0.1;
    setYRange([Math.floor((min - pad) * 10) / 10, Math.ceil((max + pad) * 10) / 10]);
  }, [displayed]);

  const resetY = useCallback(() => setYRange(DEFAULT_Y_RANGE), []);

  const captureBaseline = useCallback(async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await fetch('/api/spectrum/baseline', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText);
      setBaseline(await r.json());
      setNotice('Baseline captured.');
    } catch (err) {
      setNotice(`Capture failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const loadBaseline = useCallback(async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await fetch('/api/spectrum/baseline');
      if (r.status === 404) { setNotice('No saved baseline on the server.'); return; }
      if (!r.ok) throw new Error(r.statusText);
      setBaseline(await r.json());
      setNotice('Baseline loaded.');
    } catch (err) {
      setNotice(`Load failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  // Editable integration depth. The committed value is the server's truth;
  // the draft is what the user is typing. We mirror the server value into
  // the draft whenever it changes underneath us (e.g. another client).
  const serverFrames = frame?.integration_frames ?? status?.integration_frames ?? null;
  const [framesDraft, setFramesDraft] = useState<string>('');
  useEffect(() => {
    if (serverFrames != null) setFramesDraft(String(serverFrames));
  }, [serverFrames]);

  const commitIntegration = useCallback(async () => {
    const n = parseInt(framesDraft, 10);
    if (!Number.isFinite(n) || n === serverFrames) {
      if (serverFrames != null) setFramesDraft(String(serverFrames));
      return;
    }
    const clamped = Math.max(1, Math.min(n, 4096));
    setBusy(true); setNotice(null);
    try {
      const r = await fetch('/api/spectrum/integration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frames: clamped }),
      });
      if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText);
    } catch (err) {
      setNotice(`Could not update integration: ${(err as Error).message}`);
      if (serverFrames != null) setFramesDraft(String(serverFrames));
    } finally {
      setBusy(false);
    }
  }, [framesDraft, serverFrames]);

  const resetIntegration = useCallback(async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await fetch('/api/spectrum/reset', { method: 'POST' });
      if (!r.ok) throw new Error(r.statusText);
    } catch (err) {
      setNotice(`Reset failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const clearBaseline = useCallback(async () => {
    setBusy(true); setNotice(null);
    try {
      await fetch('/api/spectrum/baseline', { method: 'DELETE' });
      setBaseline(null);
      setNotice('Baseline cleared.');
    } catch (err) {
      setNotice(`Clear failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const chartEmptyMessage = !connected
    ? 'Spectrum websocket is offline.'
    : !frame
      ? 'Waiting for first spectrum frame from SDR service.'
      : null;

  if (status && !status.enabled) {
    return (
      <section className="spectrum-section">
        <h2 className="panel-header head-amber">
          <span className="panel-header-icon"><Radio size={14} /></span>
          Spectrum
        </h2>
        <div className="spectrum-empty">SDR disabled in config.toml.</div>
      </section>
    );
  }

  return (
    <section className="spectrum-section">
      <header className="spectrum-head">
        <h2 className="panel-header head-amber">
          <span className="panel-header-icon"><Radio size={14} /></span>
          Spectrum
        </h2>
        <div className="spectrum-summary">
          <label className="spectrum-integration-input">
            Rolling
            <input
              type="number"
              min={1}
              max={4096}
              step={1}
              value={framesDraft}
              disabled={busy}
              onChange={(e) => setFramesDraft(e.target.value)}
              onBlur={() => void commitIntegration()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape' && serverFrames != null) setFramesDraft(String(serverFrames));
              }}
            />
            frame average
          </label>
          <div className="spectrum-toolbar">
            <div className="spectrum-tool-group" role="group" aria-label="Y axis">
              <button type="button" className="ghost-btn" onClick={fitY} disabled={!frame} title="Rescale y-axis to fit the current spectrum">
                <Maximize2 size={12} /> Fit Y
              </button>
              <button type="button" className="ghost-btn" onClick={resetY} title="Reset y-axis to default range">
                Reset Y
              </button>
            </div>
            <div className="spectrum-tool-group" role="group" aria-label="Baseline">
              <button type="button" className="ghost-btn" onClick={() => void captureBaseline()} disabled={busy || !frame} title="Save the current spectrum as a baseline (persists on the server)">
                <Camera size={12} /> Capture
              </button>
              <button type="button" className="ghost-btn" onClick={() => void loadBaseline()} disabled={busy} title="Load the saved baseline from the server">
                <FolderOpen size={12} /> Load
              </button>
              <button type="button" className="ghost-btn" onClick={() => void clearBaseline()} disabled={busy || !baseline} title="Clear the active baseline and remove the saved cache">
                <Eraser size={12} /> Clear
              </button>
            </div>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void resetIntegration()}
              disabled={busy}
              title="Reset the running integration and counter"
            >
              <RotateCcw size={12} /> Reset integration
            </button>
          </div>
        </div>
        <div className="spectrum-status">
          {baseline && baselineApplies && <span className="spectrum-tag">baseline subtracted</span>}
          {baseline && !baselineApplies && <span className="spectrum-tag spectrum-tag-warn">baseline mismatched</span>}
          {!connected && <span className="spectrum-disconnected">offline</span>}
        </div>
      </header>

      <div className="spectrum-chart-wrap">
        <div className="spectrum-chart" ref={chartRef} />
        <canvas className="spectrum-waterfall" ref={waterfallCanvasRef} />
        {chartEmptyMessage && <div className="spectrum-chart-empty">{chartEmptyMessage}</div>}
      </div>

      {notice && <div className="spectrum-notice">{notice}</div>}
    </section>
  );
}

function baseOption(yRange: [number, number]): EChartsOption {
  // Axis ticks/labels in a muted periwinkle; gridlines a hair dimmer than the
  // panel hairline so they read as background structure, not foreground noise.
  const tickColor = '#6f719a';
  const lineColor = '#262a44';
  const gridColor = '#181a2c';

  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: 'inherit' },
    // Insets here must match PLOT_LEFT_PX / PLOT_RIGHT_PX so the waterfall
    // canvas painted below the chart shares the same frequency-axis pixels.
    grid: { left: PLOT_LEFT_PX, right: PLOT_RIGHT_PX, top: 26, bottom: 30, containLabel: false },
    xAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: lineColor } },
      axisTick: { show: false },
      axisLabel: {
        color: tickColor,
        fontSize: 11,
        margin: 10,
        hideOverlap: true,
        formatter: (v: number) => v.toFixed(1),
      },
      splitLine: { lineStyle: { color: gridColor } },
      splitNumber: 6,
      min: 'dataMin',
      max: 'dataMax',
    },
    yAxis: {
      type: 'value',
      name: 'dB',
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: 34,
      nameTextStyle: { color: tickColor, fontSize: 11 },
      axisLine: { lineStyle: { color: lineColor } },
      axisTick: { show: false },
      axisLabel: { color: tickColor, fontSize: 11, margin: 8 },
      splitLine: { lineStyle: { color: gridColor } },
      splitNumber: 5,
      min: yRange[0],
      max: yRange[1],
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(16, 18, 30, 0.95)',
      borderColor: lineColor,
      textStyle: { color: '#eaebf5', fontSize: 12 },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p?.value) return '';
        const [f, db] = p.value as [number, number];
        return `${f.toFixed(4)} MHz<br/>${db.toFixed(2)} dB`;
      },
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        lineStyle: { color: '#ffbc42', width: 1 },
        areaStyle: { color: 'rgba(255, 188, 66, 0.08)' },
        markLine: {
          symbol: 'none',
          silent: true,
          label: {
            formatter: 'H I',
            color: '#77cbb9',
            fontSize: 10,
            position: 'end',
            distance: [6, 4],
          },
          lineStyle: { color: 'rgba(119, 203, 185, 0.55)', type: 'dashed', width: 1 },
          data: [{ xAxis: H1_REST_MHZ }],
        },
        data: [] as [number, number][],
      },
    ],
  };
}
