import type { EChartsOption } from 'echarts';

import { H1_REST_MHZ } from './spectrum';

// Plot-area insets for the spectrum line chart. The waterfall canvas uses the
// same values so its frequency axis lines up perfectly with the trace above.
export const PLOT_LEFT_PX = 44;
export const PLOT_RIGHT_PX = 14;

// Trace colours. Amber is the normal, baseline-corrected look; red signals
// that no baseline has been captured yet, so the trace is just the raw
// receiver bandpass and shouldn't be read as real signal.
export const NORMAL_TRACE_COLOR = '#ffbc42';
export const ALERT_TRACE_COLOR = '#ff5a5f';
const TRACE_RGB: Record<string, string> = {
  [NORMAL_TRACE_COLOR]: '255, 188, 66',
  [ALERT_TRACE_COLOR]: '255, 90, 95',
};

// Shading for flagged narrowband RFI bands. A translucent slate-red wash that
// reads as "ignore this stretch" without obscuring the trace running through it.
const RFI_BAND_COLOR = 'rgba(255, 90, 95, 0.14)';

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function baseOption(yRange: [number, number]): EChartsOption {
  // Axis ticks/labels in a muted periwinkle; gridlines a hair dimmer than the
  // panel hairline so they read as background structure, not foreground noise.
  const tickColor = '#6f719a';
  const lineColor = '#262a44';
  const gridColor = '#1c1f33';
  const traceColor = '#ffbc42';

  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: 'inherit' },
    // Insets here must match PLOT_LEFT_PX / PLOT_RIGHT_PX so the waterfall
    // canvas painted below the chart shares the same frequency-axis pixels.
    grid: { left: PLOT_LEFT_PX, right: PLOT_RIGHT_PX, top: 10, bottom: 38, containLabel: false },
    xAxis: {
      type: 'value',
      name: 'Frequency (MHz)',
      nameLocation: 'middle',
      nameGap: 22,
      nameTextStyle: { color: tickColor, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: tickColor,
        fontSize: 11,
        margin: 8,
        hideOverlap: true,
        formatter: (v: number) => {
          const label = v.toFixed(1);
          return label === H1_REST_MHZ.toFixed(1) ? `{h1|${label}}` : label;
        },
        rich: {
          h1: {
            color: '#b8fff2',
            fontSize: 12,
            fontWeight: 800,
            backgroundColor: 'rgba(119, 203, 185, 0.12)',
            borderColor: 'rgba(119, 203, 185, 0.34)',
            borderWidth: 1,
            borderRadius: 3,
            padding: [2, 5],
          },
        },
      },
      splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
      splitNumber: 6,
      min: 'dataMin',
      max: 'dataMax',
    },
    yAxis: {
      type: 'value',
      name: 'dB',
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: 24,
      nameTextStyle: { color: tickColor, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: tickColor, fontSize: 11, margin: 5 },
      splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
      splitNumber: 5,
      min: yRange[0],
      max: yRange[1],
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(16, 18, 30, 0.95)',
      borderColor: lineColor,
      padding: [6, 10],
      textStyle: { color: '#eaebf5', fontSize: 12 },
      axisPointer: {
        type: 'line',
        lineStyle: { color: 'rgba(255, 188, 66, 0.45)', width: 1, type: 'dashed' },
      },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p?.value) return '';
        const [f, db] = p.value as [number, number];
        return `<strong style="color:${traceColor}">${f.toFixed(4)} MHz</strong><br/>${db.toFixed(2)} dB`;
      },
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        // No spline smoothing: each point is a real FFT bin, and smoothing
        // makes the spline (and its area fill) overshoot above sharp peaks,
        // so the gradient would poke above the trace. Straight segments keep
        // the fill strictly below the line.
        smooth: false,
        ...traceStyle(traceColor),
        data: [] as [number, number][],
      },
    ],
  };
}

// Translucent shaded bands over the stretches the hardware flagged as
// narrowband RFI. Returned fresh each frame (with an empty data array when the
// spectrum is clean) so ECharts' merge clears stale bands instead of leaving
// them painted. `silent` keeps the bands from stealing the trace's tooltip.
export function rfiMarkArea(bands: number[][] | undefined) {
  const data = (bands ?? []).map(([lo, hi]) => [{ name: 'RFI', xAxis: lo }, { xAxis: hi }]);
  return {
    silent: true,
    itemStyle: { color: RFI_BAND_COLOR },
    label: { show: false },
    data,
  };
}

// Line + area styling for the spectrum trace, keyed off the trace colour so the
// amber (baseline applied) and red (no baseline) looks stay in sync between the
// initial baseOption and the per-frame setOption.
export function traceStyle(color: string) {
  const rgb = TRACE_RGB[color] ?? TRACE_RGB[NORMAL_TRACE_COLOR];
  return {
    // A faint outer glow lifts the trace off the dark panel without the
    // 1 px line reading as thick.
    lineStyle: {
      color,
      width: 1.4,
      shadowColor: `rgba(${rgb}, 0.55)`,
      shadowBlur: 6,
    },
    // Vertical gradient: a haze at the trace fading to nothing toward the
    // noise floor, so the filled area suggests signal energy rather than a
    // flat tint.
    areaStyle: {
      opacity: 1,
      // The spectrum is dB and usually all-negative, so the default baseline
      // (y=0) is off the top of the plot — the fill would anchor upward to
      // zero. 'start' anchors it to the axis minimum so the gradient always
      // falls below the trace.
      origin: 'start' as const,
      color: {
        type: 'linear' as const,
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: `rgba(${rgb}, 0.55)` },
          { offset: 0.5, color: `rgba(${rgb}, 0.18)` },
          { offset: 1, color: `rgba(${rgb}, 0.04)` },
        ],
      },
    },
  };
}
