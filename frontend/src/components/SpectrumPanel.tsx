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

echarts.use([
  LineChart,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);
import { Camera, Eraser, FolderOpen, Maximize2, Radio, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

interface SpectrumDebug {
  statusError: string | null;
  statusFetchedAt: number | null;
  wsUrl: string | null;
  wsState: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  wsOpenedAt: number | null;
  wsClosedAt: number | null;
  wsCloseCode: number | null;
  wsCloseReason: string;
  wsError: string | null;
  lastMessageAt: number | null;
  lastFrameAt: number | null;
  frameCount: number;
  lastFrameSummary: string | null;
  parseError: string | null;
}

const INITIAL_DEBUG: SpectrumDebug = {
  statusError: null,
  statusFetchedAt: null,
  wsUrl: null,
  wsState: 'idle',
  wsOpenedAt: null,
  wsClosedAt: null,
  wsCloseCode: null,
  wsCloseReason: '',
  wsError: null,
  lastMessageAt: null,
  lastFrameAt: null,
  frameCount: 0,
  lastFrameSummary: null,
  parseError: null,
};

export function SpectrumPanel() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const [status, setStatus] = useState<SpectrumStatus | null>(null);
  const [frame, setFrame] = useState<SpectrumFrame | null>(null);
  const [connected, setConnected] = useState(false);
  const [yRange, setYRange] = useState<[number, number]>(DEFAULT_Y_RANGE);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [debug, setDebug] = useState<SpectrumDebug>(INITIAL_DEBUG);
  const [debugTick, setDebugTick] = useState(0);

  const patchDebug = useCallback((patch: Partial<SpectrumDebug>) => {
    setDebug((current) => ({ ...current, ...patch }));
  }, []);

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
        patchDebug({ statusError: null, statusFetchedAt: Date.now() });
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error).message;
        setStatus({ enabled: false, mode: 'unavailable' });
        patchDebug({ statusError: message, statusFetchedAt: Date.now() });
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [patchDebug]);

  useEffect(() => {
    const id = window.setInterval(() => setDebugTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // WebSocket subscription. Each frame is a fully-integrated spectrum from
  // the backend — we swap the series wholesale rather than appending.
  useEffect(() => {
    if (status && status.enabled === false) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/spectrum`;
    const ws = new WebSocket(wsUrl);
    patchDebug({
      wsUrl,
      wsState: 'connecting',
      wsOpenedAt: null,
      wsClosedAt: null,
      wsCloseCode: null,
      wsCloseReason: '',
      wsError: null,
      parseError: null,
    });
    ws.onopen = () => {
      setConnected(true);
      patchDebug({ wsState: 'open', wsOpenedAt: Date.now(), wsError: null });
    };
    ws.onclose = (event) => {
      setConnected(false);
      patchDebug({
        wsState: 'closed',
        wsClosedAt: Date.now(),
        wsCloseCode: event.code,
        wsCloseReason: event.reason,
      });
    };
    ws.onerror = () => {
      setConnected(false);
      patchDebug({ wsState: 'error', wsError: 'Browser reported a WebSocket error.' });
    };
    ws.onmessage = (event) => {
      patchDebug({ lastMessageAt: Date.now() });
      try {
        const next = JSON.parse(event.data) as SpectrumFrame;
        setFrame(next);
        setDebug((current) => ({
          ...current,
          lastFrameAt: Date.now(),
          frameCount: current.frameCount + 1,
          lastFrameSummary: `${next.power_db.length} bins, frames_seen=${next.frames_seen}, mode=${next.mode}`,
          parseError: null,
        }));
      } catch (err) {
        patchDebug({ parseError: (err as Error).message });
      }
    };
    return () => ws.close();
  }, [status?.enabled, patchDebug]);

  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || !frame || !displayed) return;
    const data = frame.freqs_mhz.map((f, i) => [f, displayed[i]] as [number, number]);
    chart.setOption({
      yAxis: { min: yRange[0], max: yRange[1] },
      series: [{ data }],
    });
  }, [frame, displayed, yRange]);

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
        <SpectrumDebugPanel status={status} debug={debug} frame={frame} tick={debugTick} />
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
        {chartEmptyMessage && <div className="spectrum-chart-empty">{chartEmptyMessage}</div>}
      </div>

      {notice && <div className="spectrum-notice">{notice}</div>}
      <SpectrumDebugPanel status={status} debug={debug} frame={frame} tick={debugTick} />
    </section>
  );
}

function ageMs(timestamp: number | null, tick: number): string {
  void tick;
  if (timestamp == null) return 'never';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 1) return '<1 s ago';
  if (seconds < 60) return `${seconds.toFixed(0)} s ago`;
  return `${(seconds / 60).toFixed(1)} min ago`;
}

function valueOrDash(value: unknown): string {
  if (value == null || value === '') return '-';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '-';
  return String(value);
}

function SpectrumDebugPanel({
  status,
  debug,
  frame,
  tick,
}: {
  status: SpectrumStatus | null;
  debug: SpectrumDebug;
  frame: SpectrumFrame | null;
  tick: number;
}) {
  const latestStatusAge = status?.latest_frame_age_s == null ? '-' : `${status.latest_frame_age_s.toFixed(1)} s`;
  return (
    <details className="spectrum-debug" open={!frame || debug.wsState === 'error' || debug.statusError != null}>
      <summary>Spectrum debug</summary>
      <div className="spectrum-debug-grid">
        <span>Status fetch</span><code>{debug.statusError ?? `ok (${ageMs(debug.statusFetchedAt, tick)})`}</code>
        <span>Backend mode</span><code>{valueOrDash(status?.mode)}</code>
        <span>Backend enabled</span><code>{valueOrDash(status?.enabled)}</code>
        <span>Backend latest frame age</span><code>{latestStatusAge}</code>
        <span>Backend frames seen</span><code>{valueOrDash(status?.latest_frames_seen)}</code>
        <span>Backend subscribers</span><code>{valueOrDash(status?.subscriber_count)}</code>
        <span>Config</span><code>{status ? `${status.center_freq_mhz?.toFixed(4) ?? '?'} MHz, ${status.sample_rate_mhz?.toFixed(3) ?? '?'} Msps, FFT ${status.fft_size ?? '?'}` : '-'}</code>
        <span>WebSocket</span><code>{debug.wsState} {debug.wsUrl ? `(${debug.wsUrl})` : ''}</code>
        <span>WS opened</span><code>{ageMs(debug.wsOpenedAt, tick)}</code>
        <span>WS closed</span><code>{debug.wsClosedAt == null ? '-' : `${ageMs(debug.wsClosedAt, tick)} code=${debug.wsCloseCode ?? '?'} ${debug.wsCloseReason}`}</code>
        <span>WS error</span><code>{valueOrDash(debug.wsError)}</code>
        <span>Last message</span><code>{ageMs(debug.lastMessageAt, tick)}</code>
        <span>Last parsed frame</span><code>{debug.lastFrameSummary ?? '-'}</code>
        <span>Client frames</span><code>{debug.frameCount}</code>
        <span>Parse error</span><code>{valueOrDash(debug.parseError)}</code>
      </div>
    </details>
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
    // Generous top padding gives the H I marker label room to sit above the
    // plot area without crashing into the trace, and the wider bottom leaves
    // breathing room beneath the tick labels.
    grid: { left: 52, right: 18, top: 26, bottom: 30, containLabel: false },
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
