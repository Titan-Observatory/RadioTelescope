// Tree-shakable echarts import. Pulling from `echarts/core` plus only the
// pieces we actually use keeps the bundle small enough that Rollup doesn't
// OOM when building on the Raspberry Pi. Adding any new feature (e.g. a
// scatter overlay, a legend, dataZoom) requires registering the matching
// component here.
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  MarkAreaComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

import { RefreshCw, Sliders, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  DEFAULT_Y_RANGE,
  TRACE_BOXCAR_BINS,
  boxcarSmooth,
  displayWindow,
  robustYRange,
  zeroBaselineSpectrum,
  zeroBaselineYRange,
} from '../../lib/spectrum';
import { useJsonSocket } from '../../lib/useJsonSocket';
import { startSpectrumTour } from '../../tour';
import { BaselineWizard } from '../BaselineWizard';
import { DopplerExplainer } from '../DopplerExplainer';
import type { SpectrumFrame } from '../../lib/spectrumTypes';
import {
  ALERT_TRACE_COLOR,
  NORMAL_TRACE_COLOR,
  baseOption,
  rfiMarkArea,
  round2,
  traceStyle,
} from '../../lib/spectrumChartOptions';
import {
  computeDetection,
  computeHydrogenGuide,
  computeIntegrationStats,
  computePeakMarker,
  computeRfiGuide,
} from '../../lib/spectrumDetection';
import { useSpectrumStatus } from '../../lib/useSpectrumStatus';
import { useSpectrumWaterfall } from '../../lib/useSpectrumWaterfall';

echarts.use([
  LineChart,
  GridComponent,
  MarkAreaComponent,
  TooltipComponent,
  CanvasRenderer,
]);

interface SpectrumPanelProps {
  enabled?: boolean;
  onStartGuided?: () => void;
}

type InlineInfoPopoverProps = {
  label: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  /** When set, clicking the term opens this deeper explainer instead of just
   *  toggling the hover popover. The popover gains a "Click to learn more" cue. */
  onActivate?: () => void;
};

// Full explainer modal launched from the "Doppler effect" term. Reuses the
// same animation + copy shown on the queue landing page so the in-app term
// links through to the deeper explanation.
function DopplerLearnMoreModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="doppler-modal"
      role="dialog"
      aria-modal="true"
      aria-label="The Doppler effect"
      onClick={onClose}
    >
      <div className="doppler-modal-body" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="doppler-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        <div className="doppler-modal-content">
          <DopplerExplainer />
        </div>
      </div>
    </div>
  );
}

function InlineInfoPopover({ label, ariaLabel, children, onActivate }: InlineInfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  // The popover panel is rendered in a portal on document.body. The spectrum
  // panel lives in a narrow, `overflow: hidden` column, so an in-flow panel
  // gets clipped (and the term sits close enough to the sky-map column that the
  // clipped remainder reads as "behind Aladin"). A portal escapes every
  // ancestor's clip and stacking context so the panel floats over everything.
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const halfWidth = Math.min(280, window.innerWidth - 32) / 2;
    // Center under the term, then clamp so the panel stays fully on-screen.
    const center = Math.min(
      Math.max(rect.left + rect.width / 2, halfWidth + 8),
      window.innerWidth - halfWidth - 8,
    );
    setCoords({ left: center, top: rect.bottom + 10 });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    // Reposition on scroll (capture phase catches scrolling ancestors too) and
    // on resize while the panel is visible.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  return (
    <span
      ref={wrapRef}
      className={`spectrum-inline-popover${open ? ' is-open' : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="spectrum-doppler-term"
        aria-label={ariaLabel}
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup={onActivate ? 'dialog' : undefined}
        onClick={() => (onActivate ? onActivate() : setOpen((value) => !value))}
      >
        {label}
      </button>
      {open && coords && createPortal(
        <span
          className="spectrum-inline-popover-panel is-portal"
          role="tooltip"
          style={{ left: coords.left, top: coords.top }}
        >
          {children}
          {onActivate && (
            <span className="spectrum-inline-popover-cta" aria-hidden="true">
              Click to learn more →
            </span>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}

export function SpectrumPanel({ enabled = true, onStartGuided }: SpectrumPanelProps = {}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const [frame, setFrame] = useState<SpectrumFrame | null>(null);
  // Chart-axis y-range: parks the trace in the bottom half of the plot, leaving
  // the upper half clear for annotations. EMA-smoothed toward the target each
  // frame so it tracks the noise floor continuously without jitter or jumps.
  // Held in a ref (not state) so per-frame updates don't trigger React
  // re-renders.
  const yRangeRef = useRef<[number, number]>(DEFAULT_Y_RANGE);
  const yRangeInitRef = useRef(false);
  // Signature of the FFT layout + baseline state the range is tracking. When it
  // changes the dB scale shifts wholesale, so we snap rather than slide across.
  const yRangeSigRef = useRef<string>('');
  // Tight y-range used only for the waterfall colour mapping, so the inferno
  // palette spans the full trace rather than just the bottom third of the axis.
  const waterfallRangeRef = useRef<[number, number]>(DEFAULT_Y_RANGE);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [dopplerOpen, setDopplerOpen] = useState(false);
  const [waterfallOpen, setWaterfallOpen] = useState(false);

  const { status, restartIntegration, integrationRestarting, integrationRestartError } =
    useSpectrumStatus(enabled);

  // The hardware tells us, per frame, whether the live stream is baseline-
  // corrected (`baseline_corrected`). That flag is the single source of truth:
  // it stays correct across page refreshes and for viewers who didn't capture
  // the baseline themselves, neither of which any local UI state can track.
  const baselineApplies = frame?.baseline_corrected === true;
  const sdrDisabled = status?.enabled === false;

  // Median-subtract the trace whether or not a cold-sky baseline has been
  // applied, so the y-axis fit and trace position behave identically before and
  // after baseline capture. Without a baseline this just re-centres the
  // receiver bandpass at 0 dB rather than plotting its absolute power level;
  // the red trace + "Baseline Needed" overlay still signal that it's raw.
  const displayed = useMemo(() => {
    if (!frame) return null;
    return boxcarSmooth(zeroBaselineSpectrum(frame.power_db), TRACE_BOXCAR_BINS);
  }, [frame]);

  const waterfallDisplayed = useMemo(() => {
    if (!frame) return null;
    return zeroBaselineSpectrum(frame.power_db);
  }, [frame]);

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

  // Coalesce incoming frames to one render per animation frame. The stream
  // bursts whenever the main thread was busy (queued WS frames then arrive
  // back-to-back); rendering every one would stack a full chart + waterfall
  // repaint per frame and stall the UI. We keep only the newest frame and flush
  // it on the next rAF — the same drop-oldest policy the backend broadcaster
  // uses, so the live view shows the latest spectrum and never falls behind.
  const pendingFrameRef = useRef<SpectrumFrame | null>(null);
  const flushRafRef = useRef<number | null>(null);
  const ingestFrame = useCallback((f: SpectrumFrame) => {
    pendingFrameRef.current = f;
    if (flushRafRef.current != null) return;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null;
      const latest = pendingFrameRef.current;
      pendingFrameRef.current = null;
      if (latest) setFrame(latest);
    });
  }, []);
  useEffect(() => () => {
    if (flushRafRef.current != null) cancelAnimationFrame(flushRafRef.current);
  }, []);

  // WebSocket subscription. Each frame is a fully-integrated spectrum from
  // the backend — we swap the series wholesale rather than appending.
  const { connected } = useJsonSocket<SpectrumFrame>('/ws/spectrum', {
    enabled: enabled && (status == null || status.enabled !== false),
    onMessage: ingestFrame,
  });

  // Update the spectrum line chart on each new frame / range change. This also
  // advances the shared EMA y-range refs the waterfall reads, so it must stay
  // registered before useSpectrumWaterfall below.
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || !frame || !displayed) return;
    const data = frame.freqs_mhz.map((f, i) => [f, displayed[i]] as [number, number]);
    // Both raw and baseline-corrected frames are median-subtracted (see
    // `displayed`/zeroBaselineSpectrum) and fit with the same symmetric
    // zero-baseline range, so the trace stays pinned at 0 dB and the axis
    // scales the same way before and after a baseline is captured.
    // The target is a robust percentile fit (spurs/dead bins can't blow it
    // open) that we EMA-smooth toward each frame, so the axis tracks without
    // jitter or jumps. We snap (skip the EMA) only when the FFT layout /
    // baseline state changes, since the dB scale shifts wholesale there and
    // sliding across it would look wrong. The waterfall keeps its own tight
    // colour range so its inferno palette still spans the full trace.
    const axisTarget = zeroBaselineYRange(displayed);
    const wfTarget = robustYRange(displayed);
    const sig = `${frame.center_freq_mhz.toFixed(6)}|${frame.sample_rate_mhz.toFixed(6)}|${frame.freqs_mhz.length}|${baselineApplies ? 'baseline' : 'raw'}`;
    const fresh = !yRangeInitRef.current || sig !== yRangeSigRef.current;
    const k = 0.15;
    const ema = (cur: [number, number], target: [number, number]): [number, number] =>
      fresh ? target : [cur[0] + (target[0] - cur[0]) * k, cur[1] + (target[1] - cur[1]) * k];
    yRangeRef.current = ema(yRangeRef.current, axisTarget);
    waterfallRangeRef.current = ema(waterfallRangeRef.current, wfTarget);
    yRangeSigRef.current = sig;
    yRangeInitRef.current = true;
    const [yMin, yMax] = yRangeRef.current;
    const win = displayWindow(frame);
    const traceColor = baselineApplies ? NORMAL_TRACE_COLOR : ALERT_TRACE_COLOR;
    chart.setOption({
      xAxis: win ? { min: win.xMin, max: win.xMax } : {},
      yAxis: { min: round2(yMin), max: round2(yMax) },
      series: [{ data, ...traceStyle(traceColor), markArea: rfiMarkArea(frame.rfi_bands) }],
    });
  }, [frame, displayed, baselineApplies]);

  const { waterfallCanvasRef, resetWaterfall } = useSpectrumWaterfall({
    frame,
    waterfallDisplayed,
    baselineApplies,
    waterfallRangeRef,
  });

  useEffect(() => {
    if (connected && status?.latest_frame_age_s !== null) return;
    setFrame(null);
    pendingFrameRef.current = null; // drop any queued frame so it can't restore stale data
    resetWaterfall();
    yRangeInitRef.current = false;
    chartInstance.current?.setOption({
      series: [{ data: [], markArea: rfiMarkArea([]) }],
    });
  }, [connected, status?.latest_frame_age_s, resetWaterfall]);

  const chartEmptyMessage = !connected || !frame
    ? 'Waiting for spectrum stream to start'
    : null;
  const integrationStats = useMemo(() => computeIntegrationStats(frame), [frame]);
  const hydrogenGuide = useMemo(() => computeHydrogenGuide(frame), [frame]);
  const rfiGuide = useMemo(() => computeRfiGuide(frame, displayed, yRangeRef.current), [frame, displayed]);
  const detection = useMemo(() => computeDetection(frame, displayed), [frame, displayed]);
  const velocity = detection?.detected ? detection.velocityKms : null;
  const peakMarker = computePeakMarker(frame, detection, hydrogenGuide, yRangeRef.current);

  return (
    <section className="spectrum-section">
      <header className="spectrum-head">
        <div className="spectrum-head-titles">
          <div className="spectrum-head-row">
            <h2 className="panel-header head-amber spectrum-title-lg">
              Hydrogen Observation
            </h2>
            {onStartGuided && (
              <button
                type="button"
                className="spectrum-guided-cta"
                onClick={onStartGuided}
                disabled={!connected || !frame}
                title={!connected || !frame ? 'Waiting for SDR…' : 'Walk through a hydrogen-line observation step by step'}
              >
                <Sparkles size={14} /> Guided observation
              </button>
            )}
          </div>
          <p className="spectrum-subtitle">
            Neutral hydrogen in the Milky Way emits radio waves with a frequency of <strong>1420.4 MHz</strong>. The spectrum below displays the range of frequencies being received by the telescope, centered on this reference frequency. Gas moving toward or away from the telescope shifts the signal slightly by the{' '}
            <InlineInfoPopover
              label="Doppler effect"
              ariaLabel="Learn more about the Doppler effect"
              onActivate={() => setDopplerOpen(true)}
            >
              <strong>Motion shifts the observed frequency.</strong>
              <span>
                Gas clouds moving toward us are blueshifted slightly higher in frequency, while gas clouds moving away are redshifted slightly lower.
              </span>
            </InlineInfoPopover>. By observing several points along the galactic plane, you can see the relative motion and distribution of the hydrogen gas in our own Milky Way galaxy.
          </p>
        </div>
        <div className="spectrum-status">
          {sdrDisabled
            ? <span className="spectrum-disconnected">SDR disabled</span>
            : (!connected && <span className="spectrum-disconnected">offline</span>)}
        </div>
      </header>

      {!baselineApplies ? (
        <div className="baseline-prompt" role="status" aria-label="Baseline not captured">
          <p className="baseline-prompt-text">
            {sdrDisabled
              ? 'The SDR is disabled in config.toml, so the live spectrum is hidden. You can still walk through the baseline capture flow for development.'
              : "Without a cold-sky baseline, the spectrum is dominated by the receiver's bandpass shape and local radio frequency interference (RFI)."}
          </p>
          <button
            type="button"
            className="baseline-prompt-go"
            onClick={() => setWizardOpen(true)}
            title={sdrDisabled
              ? 'Open the guided baseline flow without rendering the SDR spectrum'
              : 'Open the guided flow to point at empty sky and capture a baseline'}
          >
            Capture baseline →
          </button>
        </div>
      ) : frame ? (
        <div className="spectrum-readouts" aria-label="Hydrogen line measurements">
          <div className="spectrum-readout">
            <span className="spectrum-readout-label">Peak</span>
            <span className="spectrum-readout-value">
              {detection?.detected ? `${detection.freqMhz.toFixed(3)} MHz` : '—'}
            </span>
          </div>
          <div className="spectrum-readout">
            <span className="spectrum-readout-label">Strength</span>
            <span className="spectrum-readout-value">
              {detection?.detected ? `+${detection.prominenceDb.toFixed(1)} dB` : '—'}
            </span>
          </div>
          <div className="spectrum-readout">
            <span className="spectrum-readout-label">Doppler velocity</span>
            <span className="spectrum-readout-value">
              {velocity == null ? '—' : `${velocity >= 0 ? '+' : '−'}${Math.abs(velocity).toFixed(0)} km/s`}
            </span>
            {velocity != null && Math.abs(velocity) >= 3 && (
              <span className="spectrum-readout-sub">
                {velocity >= 0 ? 'gas receding' : 'gas approaching'}
              </span>
            )}
          </div>
          <button
            type="button"
            className="ghost-btn spectrum-recapture-btn"
            onClick={() => setWizardOpen(true)}
            title="Capture a fresh baseline"
          >
            <Sliders size={12} /> Recapture
          </button>
        </div>
      ) : null}

      {sdrDisabled ? (
        <div className="spectrum-empty" role="status">
          Spectrum hidden because the SDR is disabled.
        </div>
      ) : (
      <div className="spectrum-chart-wrap">
        <div className="spectrum-chart-head">
          {baselineApplies && (
            <button
              type="button"
              className="spectrum-learn-link"
              onClick={() => startSpectrumTour()}
            >
              How to read this chart
            </button>
          )}
          {integrationRestartError && (
            <p className="spectrum-notice" role="status">
              {integrationRestartError}
            </p>
          )}
          <div className="spectrum-chart-caption">
            <span className="spectrum-chart-title">Relative Power vs. frequency</span>
            {integrationStats && (
              <p className="spectrum-stats" aria-label="Integration statistics">
                Integrating <strong>~{integrationStats.windowSeconds.toFixed(1)} s</strong>
                {' '}({integrationStats.effectiveFrames}/{integrationStats.targetFrames} frames)
                {' · '}
                <strong>{integrationStats.binHz.toFixed(0)} Hz</strong> bins
                {' · '}
                {integrationStats.frameHz.toFixed(1)} Hz FFT
              </p>
            )}
          </div>
          <button
            type="button"
            className="spectrum-restart-integration"
            onClick={restartIntegration}
            disabled={!connected || integrationRestarting}
            title={!connected ? 'Waiting for SDR stream' : 'Restart integration without clearing the baseline'}
            aria-label={integrationRestarting ? 'Restarting integration' : 'Restart integration'}
          >
            <RefreshCw
              size={14}
              className={integrationRestarting ? 'is-spinning' : undefined}
            />
          </button>
        </div>

        <div className="spectrum-chart-box">
          {baselineApplies && (
            <div className="spectrum-chart-note">Baseline corrected</div>
          )}
          {baselineApplies && hydrogenGuide && (
            <div
              className="spectrum-hydrogen-guide"
              style={{
                '--h1-line-left': hydrogenGuide.lineLeft,
              } as React.CSSProperties}
              aria-hidden
            >
              <span className="spectrum-hydrogen-line" />
              {peakMarker && (
                <span className="spectrum-peak-marker" style={{ left: peakMarker.left, top: peakMarker.top }} />
              )}
            </div>
          )}
          {rfiGuide.length > 0 && (
            <div className="spectrum-rfi-guide" aria-hidden>
              {rfiGuide.map((marker) => (
                <span className="spectrum-rfi-marker" style={{ left: marker.left }} key={marker.key}>
                  <span className="spectrum-rfi-line" style={{ bottom: marker.bottom }} />
                  {marker.showLabel && <span className="spectrum-rfi-label">RFI</span>}
                </span>
              ))}
            </div>
          )}
          <div className="spectrum-chart" ref={chartRef} />
          {chartEmptyMessage && (
            <div className="spectrum-chart-empty">
              {chartEmptyMessage}
            </div>
          )}
          {!baselineApplies && frame && (
            <div className="spectrum-baseline-overlay" aria-hidden>
              Baseline Needed
            </div>
          )}
        </div>

        <details
          className="spectrum-waterfall-dropdown"
          open={waterfallOpen}
          onToggle={(event) => setWaterfallOpen(event.currentTarget.open)}
        >
          <summary className="spectrum-waterfall-summary">
            <span>Waterfall</span>
            <small className="spectrum-waterfall-caption">signal history over time</small>
          </summary>
          <canvas className="spectrum-waterfall" ref={waterfallCanvasRef} />
        </details>
      </div>
      )}

      <BaselineWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        frame={frame}
      />

      {dopplerOpen && <DopplerLearnMoreModal onClose={() => setDopplerOpen(false)} />}
    </section>
  );
}
