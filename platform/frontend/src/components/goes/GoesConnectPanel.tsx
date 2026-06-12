// GOES acquisition panel — takes the SpectrumPanel's slot in the right
// column when the hardware boots in GOES mode. Walks the operator through
// connecting to the satellite: slew to the computed look angles, peak the
// SNR, watch the acquisition ladder climb to frame lock.

import { Navigation, Satellite } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { angularSeparationDeg, GOES_STAGES, stageRank } from '../../lib/goes';
import type {
  GoesFrame,
  GoesSatelliteInfo,
  ObservationInfo,
  RoboClawTelemetry,
  TelescopeConfig,
} from '../../types';

interface GoesConnectPanelProps {
  observation: ObservationInfo;
  frame: GoesFrame | null;
  connected: boolean;
  telemetry: RoboClawTelemetry | null;
  config: TelescopeConfig | null;
  gotoAltAz: (altDeg: number, azDeg: number) => Promise<void>;
}

const SNR_METER_MAX_DB = 16;

export function GoesConnectPanel({
  observation,
  frame,
  connected,
  telemetry,
  config,
  gotoAltAz,
}: GoesConnectPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(observation.target_satellite_id);
  const satellite: GoesSatelliteInfo | null = useMemo(() => {
    const sats = observation.satellites;
    return sats.find((s) => s.id === selectedId) ?? sats.find((s) => s.is_target) ?? sats[0] ?? null;
  }, [observation.satellites, selectedId]);

  const pointing = useMemo(() => {
    if (!satellite || telemetry?.altitude_deg == null || telemetry?.azimuth_deg == null) return null;
    const errorDeg = angularSeparationDeg(
      telemetry.altitude_deg, telemetry.azimuth_deg,
      satellite.elevation_deg, satellite.azimuth_deg,
    );
    const beam = config?.beam_fwhm_deg ?? 1.2;
    return { errorDeg, withinBeam: errorDeg <= beam / 2 };
  }, [satellite, telemetry?.altitude_deg, telemetry?.azimuth_deg, config?.beam_fwhm_deg]);

  const rank = stageRank(frame?.stage);
  const snrDb = frame?.snr_db ?? null;
  const snrPct = snrDb == null ? 0 : Math.max(0, Math.min(100, (snrDb / SNR_METER_MAX_DB) * 100));
  const lockPct = frame ? Math.max(0, Math.min(100, (frame.snr_lock_db / SNR_METER_MAX_DB) * 100)) : 0;

  return (
    <section className="spectrum-section goes-connect">
      <header className="spectrum-head">
        <div className="spectrum-head-titles">
          <h2 className="panel-header head-amber">GOES satellite downlink</h2>
          <p className="spectrum-subtitle">
            Geostationary weather satellite
            {observation.downlink_freq_mhz != null && (
              <> broadcasting at {observation.downlink_freq_mhz.toFixed(1)}&nbsp;MHz</>
            )}
            . Point the dish, peak the signal, and the decoder does the rest.
          </p>
        </div>
        <div className="spectrum-status">
          {!connected && <span className="spectrum-disconnected">offline</span>}
        </div>
      </header>

      <div className="spectrum-chart-wrap goes-connect-body">
        {/* ── Target satellite ─────────────────────────────────────── */}
        <div className="goes-target-card">
          <div className="goes-target-row">
            <Satellite size={14} className="goes-target-icon" />
            {observation.satellites.length > 1 ? (
              <select
                className="goes-target-select"
                value={satellite?.id ?? ''}
                onChange={(e) => setSelectedId(e.target.value)}
                aria-label="Target satellite"
              >
                {observation.satellites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            ) : (
              <span className="goes-target-name">{satellite?.name ?? 'No satellite configured'}</span>
            )}
          </div>
          {satellite && (
            <div className="goes-target-grid">
              <div className="goes-readout">
                <span className="spectrum-readout-label">Azimuth</span>
                <span className="spectrum-readout-value">{satellite.azimuth_deg.toFixed(2)}°</span>
              </div>
              <div className="goes-readout">
                <span className="spectrum-readout-label">Elevation</span>
                <span className="spectrum-readout-value">{satellite.elevation_deg.toFixed(2)}°</span>
              </div>
              <div className="goes-readout">
                <span className="spectrum-readout-label">Off target</span>
                <span className="spectrum-readout-value">
                  {pointing ? `${pointing.errorDeg.toFixed(2)}°` : '—'}
                </span>
                {pointing?.withinBeam && <span className="goes-beam-badge">in beam</span>}
              </div>
              <button
                type="button"
                className="goes-slew-btn"
                disabled={!satellite.visible}
                title={satellite.visible
                  ? `Slew to Az ${satellite.azimuth_deg.toFixed(2)}°, El ${satellite.elevation_deg.toFixed(2)}°`
                  : 'Below the horizon from this observatory'}
                onClick={() => void gotoAltAz(satellite.elevation_deg, satellite.azimuth_deg)}
              >
                <Navigation size={13} /> Slew to satellite
              </button>
            </div>
          )}
          {satellite && !satellite.visible && (
            <p className="goes-target-warning">
              {satellite.name} is below the horizon from this site — pick another satellite.
            </p>
          )}
        </div>

        {/* ── Acquisition ladder ───────────────────────────────────── */}
        <ol className="goes-stepper" aria-label="Acquisition progress">
          {GOES_STAGES.map((step, i) => (
            <li
              key={step.id}
              className={`goes-step${i < rank ? ' is-done' : ''}${i === rank ? ' is-active' : ''}`}
              title={step.hint}
            >
              <span className="goes-step-dot" aria-hidden />
              <span className="goes-step-label">{step.label}</span>
            </li>
          ))}
        </ol>

        {/* ── Signal quality ───────────────────────────────────────── */}
        <div className="goes-snr-block" aria-label="Signal quality">
          <div className="goes-snr-head">
            <span className="spectrum-readout-label">SNR</span>
            <span className="goes-snr-value">{snrDb != null ? `${snrDb.toFixed(1)} dB` : '—'}</span>
            <span className="goes-snr-detail">
              {frame?.freq_offset_hz != null && `carrier ${frame.freq_offset_hz >= 0 ? '+' : ''}${(frame.freq_offset_hz / 1000).toFixed(1)} kHz`}
            </span>
          </div>
          <div className="goes-snr-meter">
            <div className="goes-snr-fill" style={{ width: `${snrPct}%` }} data-locked={frame?.demod_locked || undefined} />
            <div className="goes-snr-threshold" style={{ left: `${lockPct}%` }} title={`Lock threshold ${frame?.snr_lock_db ?? '—'} dB`} />
          </div>
          <p className="goes-snr-hint">
            {rank <= 0
              ? 'Nudge the dish in small steps and watch this meter — peak it like tuning an antenna.'
              : rank === 1
                ? 'Carrier acquired. Hold the dish steady; frame sync follows within seconds.'
                : 'Locked. Decoded products appear in the explorer below the sky map.'}
          </p>
        </div>

        {/* ── SNR history + constellation ──────────────────────────── */}
        <div className="goes-scopes">
          <div className="goes-scope">
            <span className="spectrum-readout-label">Signal history</span>
            <SnrHistoryScope frame={frame} />
          </div>
          <div className="goes-scope goes-scope-square">
            <span className="spectrum-readout-label">Constellation</span>
            <ConstellationScope frame={frame} />
          </div>
        </div>

        {!connected && (
          <div className="spectrum-chart-empty goes-empty">
            <span className="spectrum-chart-empty-dot" aria-hidden />
            GOES status websocket is offline.
          </div>
        )}
        {connected && !frame && (
          <div className="spectrum-chart-empty goes-empty">
            <span className="spectrum-chart-empty-dot" aria-hidden />
            Waiting for the demodulator to start…
          </div>
        )}
      </div>
    </section>
  );
}

// ── Canvas scopes ──────────────────────────────────────────────────────────

function useScopeCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
  });
  return ref;
}

// Rolling SNR trace (last ~2 minutes) — the readout you watch while nudging
// the dish to peak on the satellite, like a slow signal-strength meter.
const SNR_HISTORY_POINTS = 240;
const SNR_SCOPE_MAX_DB = 16;

function SnrHistoryScope({ frame }: { frame: GoesFrame | null }) {
  const historyRef = useRef<Array<number | null>>([]);
  const lastTimestampRef = useRef<number | null>(null);

  if (frame && frame.timestamp !== lastTimestampRef.current) {
    lastTimestampRef.current = frame.timestamp;
    historyRef.current.push(frame.snr_db);
    if (historyRef.current.length > SNR_HISTORY_POINTS) {
      historyRef.current.splice(0, historyRef.current.length - SNR_HISTORY_POINTS);
    }
  }

  const ref = useScopeCanvas((ctx, w, h) => {
    const history = historyRef.current;
    if (history.length < 2) return;
    const toY = (snr: number) =>
      h - (Math.max(0, Math.min(SNR_SCOPE_MAX_DB, snr)) / SNR_SCOPE_MAX_DB) * h;

    // Lock-threshold guide line.
    if (frame) {
      ctx.strokeStyle = 'rgba(155, 158, 206, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, toY(frame.snr_lock_db));
      ctx.lineTo(w, toY(frame.snr_lock_db));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    let started = false;
    for (let i = 0; i < history.length; i++) {
      const snr = history[i];
      if (snr == null) { started = false; continue; }
      const x = (i / (SNR_HISTORY_POINTS - 1)) * w;
      if (!started) { ctx.moveTo(x, toY(snr)); started = true; }
      else ctx.lineTo(x, toY(snr));
    }
    ctx.strokeStyle = frame?.demod_locked ? '#77cbb9' : '#ffbc42';
    ctx.lineWidth = Math.max(1, w / 320);
    ctx.stroke();
  });
  return <canvas className="goes-scope-canvas" ref={ref} />;
}

function ConstellationScope({ frame }: { frame: GoesFrame | null }) {
  const ref = useScopeCanvas((ctx, w, h) => {
    const points = frame?.constellation;
    if (!points || points.length === 0) return;
    // Fixed ±2 view: BPSK symbols converge on (±1, 0) as the loops lock.
    const scale = Math.min(w, h) / 4;
    const cx = w / 2;
    const cy = h / 2;
    ctx.strokeStyle = 'rgba(111, 113, 154, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.fillStyle = frame?.demod_locked ? 'rgba(126, 231, 135, 0.85)' : 'rgba(255, 188, 66, 0.7)';
    const r = Math.max(1.5, Math.min(w, h) / 90);
    for (const [i, q] of points) {
      ctx.beginPath();
      ctx.arc(cx + i * scale, cy - q * scale, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return <canvas className="goes-scope-canvas" ref={ref} />;
}
