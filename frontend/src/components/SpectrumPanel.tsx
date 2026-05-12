import * as echarts from 'echarts';
import { Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// 21 cm neutral-hydrogen line — the rolling integration is centred here.
const H1_REST_MHZ = 1420.4058;

interface SpectrumFrame {
  timestamp: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
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
}

export function SpectrumPanel() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const [status, setStatus] = useState<SpectrumStatus | null>(null);
  const [frame, setFrame] = useState<SpectrumFrame | null>(null);
  const [connected, setConnected] = useState(false);

  // Initialise the ECharts instance once. ResizeObserver keeps it sized
  // against the panel even as the dashboard grid reflows.
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    chartInstance.current = chart;
    chart.setOption(baseOption());

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(chartRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartInstance.current = null;
    };
  }, []);

  useEffect(() => {
    fetch('/api/spectrum/status')
      .then((r) => r.json())
      .then((s: SpectrumStatus) => setStatus(s))
      .catch(() => setStatus({ enabled: false, mode: 'unavailable' }));
  }, []);

  // WebSocket subscription. We swap series data on each frame instead of
  // pushing — the backend already does rolling integration, so each frame is
  // a complete spectrum we want to render whole.
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

  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || !frame) return;
    const data = frame.freqs_mhz.map((f, i) => [f, frame.power_db[i]] as [number, number]);
    chart.setOption({
      series: [{ data }],
    });
  }, [frame]);

  if (status && !status.enabled) {
    return (
      <section className="spectrum-section">
        <h2 className="panel-header">
          <span className="panel-header-icon"><Radio size={14} /></span>
          Spectrum
        </h2>
        <div className="spectrum-empty">SDR disabled in config.toml.</div>
      </section>
    );
  }

  return (
    <section className="spectrum-section">
      <h2 className="panel-header">
        <span className="panel-header-icon"><Radio size={14} /></span>
        Spectrum
        <span className="spectrum-meta">
          {status?.center_freq_mhz != null && (
            <span>centre {status.center_freq_mhz.toFixed(3)} MHz</span>
          )}
          {status?.integration_frames != null && (
            <span>· {status.integration_frames} frames</span>
          )}
          {frame?.mode && <span>· {frame.mode}</span>}
          {!connected && <span className="spectrum-disconnected">· offline</span>}
        </span>
      </h2>
      <div className="spectrum-chart" ref={chartRef} />
    </section>
  );
}

function baseOption(): echarts.EChartsOption {
  return {
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 48, right: 16, top: 12, bottom: 32, containLabel: false },
    xAxis: {
      type: 'value',
      name: 'MHz',
      nameLocation: 'middle',
      nameGap: 22,
      nameTextStyle: { color: '#9b9ece', fontSize: 11 },
      axisLine: { lineStyle: { color: '#2e3150' } },
      axisLabel: {
        color: '#9b9ece',
        fontSize: 11,
        formatter: (v: number) => v.toFixed(2),
      },
      splitLine: { lineStyle: { color: '#1d2032' } },
      min: 'dataMin',
      max: 'dataMax',
    },
    yAxis: {
      type: 'value',
      name: 'dB',
      nameLocation: 'end',
      nameGap: 8,
      nameTextStyle: { color: '#9b9ece', fontSize: 11 },
      axisLine: { lineStyle: { color: '#2e3150' } },
      axisLabel: { color: '#9b9ece', fontSize: 11 },
      splitLine: { lineStyle: { color: '#1d2032' } },
      scale: true,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(16, 18, 30, 0.95)',
      borderColor: '#2e3150',
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
        areaStyle: { color: 'rgba(255, 188, 66, 0.10)' },
        markLine: {
          symbol: 'none',
          silent: true,
          label: {
            formatter: 'H I 1420.405',
            color: '#77cbb9',
            fontSize: 10,
          },
          lineStyle: { color: '#77cbb9', type: 'dashed', width: 1 },
          data: [{ xAxis: H1_REST_MHZ }],
        },
        data: [] as [number, number][],
      },
    ],
  };
}
