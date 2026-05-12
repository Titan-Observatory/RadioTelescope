import './styles/main.css';

import {
  Activity, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Cpu, Crosshair, Download, Gauge, Home, LogOut, Map, Navigation, Square,
  Thermometer, Upload, Zap,
} from 'lucide-react';
import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api, ApiError } from './api';
import { BRAND } from './branding';
import { SkyMap } from './components/SkyMap';
import { SpectrumPanel } from './components/SpectrumPanel';
import { QueuePage } from './components/QueuePage';
import {
  fetchQueueConfig, fetchQueueStatus, joinQueue, leaveQueue,
  type QueueConfig, type QueueStatus,
} from './queue';
import type { CommandInfo, MotorSnapshot, RoboClawTelemetry, TelescopeConfig } from './types';

// Apply branding to the document head so favicon + title share the same source as the TopBar.
document.title = `${BRAND.name} · ${BRAND.tagline}`;
const favicon = document.getElementById('favicon') as HTMLLinkElement | null;
if (favicon) favicon.href = BRAND.faviconUrl;

interface ErrorLogEntry {
  id: number;
  source: string;
  message: string;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
}

interface ControllerIssue {
  title: string;
  summary: string;
  action: string;
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [telemetry, setTelemetry] = useState<RoboClawTelemetry | null>(null);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [telescopeConfig, setTelescopeConfig] = useState<TelescopeConfig | null>(null);
  const [errorLog, setErrorLog] = useState<ErrorLogEntry[]>([]);
  const [targetAz, setTargetAz] = useState(0);
  const [targetAlt, setTargetAlt] = useState(45);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [queueConfig, setQueueConfig] = useState<QueueConfig | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const nextErrorId = useRef(1);

  const logEvent = (source: string, message: string) => {
    const now = new Date();
    setErrorLog((entries) => {
      const latest = entries[0];
      if (latest && latest.source === source && latest.message === message) {
        return [{ ...latest, lastSeen: now, count: latest.count + 1 }, ...entries.slice(1)];
      }
      return [
        { id: nextErrorId.current++, source, message, firstSeen: now, lastSeen: now, count: 1 },
        ...entries,
      ].slice(0, 20);
    });
  };

  // Bootstrap queue state and telemetry. Telemetry is read-only and visible
  // to spectators as well as the active controller.
  useEffect(() => {
    void fetchQueueConfig().then(setQueueConfig).catch(() => {/* queue may be disabled */});
    void fetchQueueStatus().then(setQueueStatus).catch(() => {/* not joined yet */});

    void api.status().then((next) => {
      setTelemetry(next);
      if (next.last_error) logEvent('RoboClaw', next.last_error);
    }).catch((err) => {
      const message = errorMessage(err);
      setNotice(message);
      logEvent('API', message);
    });
    void api.commands().then(setCommands).catch((err) => {
      const message = errorMessage(err);
      setNotice(message);
      logEvent('API', message);
    });
    void api.telescopeConfig().then(setTelescopeConfig).catch(() => {/* non-critical */});

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/roboclaw`);
    ws.onmessage = (event) => {
      const next = JSON.parse(event.data) as RoboClawTelemetry;
      setTelemetry(next);
      if (next.last_error) logEvent('RoboClaw', next.last_error);
    };
    ws.onerror = () => {
      const message = 'RoboClaw telemetry websocket disconnected.';
      setNotice(message);
      logEvent('WebSocket', message);
    };
    return () => ws.close();
  }, []);

  // Subscribe to queue status updates as long as we have a session cookie.
  useEffect(() => {
    if (queueStatus == null || queueStatus.position < 0) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/queue`);
    ws.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as QueueStatus;
        if (typeof next.position === 'number') setQueueStatus(next);
      } catch { /* ignore */ }
    };

    // Treat any UI activity (click, scroll, keypress, pointer) as a heartbeat
    // that resets the server-side idle countdown. Throttled so we send at
    // most once every few seconds while the user is interacting.
    let lastSent = 0;
    const sendActivity = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - lastSent < 5000) return;
      lastSent = now;
      try { ws.send('a'); } catch { /* ignore */ }
    };
    const events: (keyof DocumentEventMap)[] = ['click', 'scroll', 'keydown', 'pointerdown', 'wheel', 'touchstart'];
    for (const e of events) {
      document.addEventListener(e, sendActivity, { passive: true, capture: true });
    }
    return () => {
      for (const e of events) {
        document.removeEventListener(e, sendActivity, { capture: true });
      }
      ws.close();
    };
  }, [queueStatus?.position === -1, queueStatus == null]);

  const handleJoin = async (turnstileToken: string | null) => {
    setJoining(true);
    setJoinError(null);
    try {
      const next = await joinQueue(turnstileToken);
      setQueueStatus(next);
    } catch (err) {
      setJoinError(errorMessage(err));
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async () => {
    await leaveQueue();
    setQueueStatus({ ...(queueStatus ?? {} as QueueStatus), position: -1, is_active: false });
  };

  const commandById = useMemo(
    () => Object.fromEntries(commands.map((c) => [c.id, c])),
    [commands],
  );

  const runCommand = async (commandId: string, args: Record<string, number | boolean>) => {
    const command = commandById[commandId];
    if (!command) { setNotice(`Command unavailable: ${commandId}`); return; }
    setNotice(null);
    try {
      await api.execute(command.id, args);
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const stopAll = async () => {
    setNotice(null);
    try {
      await api.stop();
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const gotoAltAz = async (altDeg: number, azDeg: number) => {
    setNotice(null);
    try {
      await api.gotoAltAz(altDeg, azDeg);
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const syncAltAz = async (altDeg: number, azDeg: number) => {
    setNotice(null);
    try {
      await api.syncAltAz(altDeg, azDeg);
      setNotice(`Pointing set to Az ${azDeg.toFixed(1)}° · Alt ${altDeg.toFixed(1)}°`);
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const homeElevation = async () => {
    setNotice(null);
    try {
      const r = await api.homeElevation();
      setNotice(r.message);
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const zeroAzimuth = async () => {
    setNotice(null);
    try {
      const r = await api.zeroAzimuth();
      setNotice(r.message);
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const zeroAltitude = async () => {
    setNotice(null);
    try {
      const r = await api.zeroAltitude();
      setNotice(r.message);
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const handleMapTarget = useCallback((az: number, alt: number) => {
    setTargetAz(Math.round(az * 1000) / 1000);
    setTargetAlt(Math.round(alt * 1000) / 1000);
  }, []);

  const controllerIssue = explainControllerError(telemetry?.last_error ?? null);

  // Queue gating: when the queue is enabled and we are not the active
  // controller, render the spectator/queue page instead of the control UI.
  // Position 0 = active controller; -1 = not in queue; >0 = waiting.
  const queueEnabled = queueConfig?.enabled ?? false;
  const isActiveController = !queueEnabled || queueStatus?.is_active === true;

  if (queueEnabled && !isActiveController) {
    return (
      <QueuePage
        status={queueStatus}
        joining={joining}
        joinError={joinError}
        siteKey={queueConfig?.turnstile_site_key ?? null}
        turnstileEnabled={queueConfig?.turnstile_enabled ?? false}
        onJoin={handleJoin}
      />
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        telemetry={telemetry}
        leaseStatus={queueEnabled && queueStatus?.is_active ? queueStatus : null}
        onLeaveLease={() => void handleLeave()}
      />

      {telemetry?.connection.mode === 'error' && (
        <div className="banner banner-error">
          <AlertTriangle size={14} />
          <span>Lost connection to the telescope. Check that all cables are secure and try refreshing.</span>
        </div>
      )}

      {telemetry?.last_error && (
        <ControllerIssueBanner issue={controllerIssue} />
      )}

      {notice && (
        <div className={`banner ${notice.toLowerCase().includes('homed') || notice.toLowerCase().includes('zero') || notice.toLowerCase().includes('set') ? 'banner-ok' : 'banner-error'}`}>
          <AlertTriangle size={14} />
          <span>{notice}</span>
        </div>
      )}

      {errorLog.length > 0 && <ErrorLog entries={errorLog} onClear={() => setErrorLog([])} />}

      <main className="dashboard">
        <section className="panel controls-panel">
          <TelescopeControls telemetry={telemetry} runCommand={runCommand} stopAll={stopAll} gotoAltAz={gotoAltAz} targetAz={targetAz} targetAlt={targetAlt} setTargetAz={setTargetAz} setTargetAlt={setTargetAlt} />
          <SpectrumPanel />
          <AdminPanel syncAltAz={syncAltAz} homeElevation={homeElevation} zeroAzimuth={zeroAzimuth} zeroAltitude={zeroAltitude} targetAz={targetAz} targetAlt={targetAlt} />
          <PidTuningPanel onNotice={setNotice} />
        </section>
        <section className="panel skymap-panel">
          <PanelHeader icon={<Map size={14} />} title="Sky Map" />
          <SkyMap telemetry={telemetry} config={telescopeConfig} onNotice={setNotice} onTarget={handleMapTarget} />
        </section>
        <section className="panel telemetry-panel">
          <TelemetryDashboard telemetry={telemetry} />
        </section>
      </main>
    </div>
  );
}

function LeaseChip({ status, onLeave }: { status: QueueStatus; onLeave: () => void }) {
  const remaining = Math.max(0, Math.round(status.lease_remaining_s ?? 0));
  const idle = status.idle_remaining_s == null ? null : Math.max(0, Math.round(status.idle_remaining_s));
  return (
    <span className="topbar-lease" title="You are in control of the telescope.">
      <Activity size={12} />
      <span className="topbar-lease-label">Session</span>
      <strong>{formatSeconds(remaining)}</strong>
      {idle != null && idle < 30 && (
        <span className="topbar-lease-idle">· idle {idle}s</span>
      )}
      <button className="topbar-lease-leave" onClick={onLeave} title="Release control">
        <LogOut size={11} /> Release
      </button>
    </span>
  );
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// ─── TopBar ──────────────────────────────────────────────────────────────────

const MODE_LABEL: Record<string, string> = {
  serial: 'Connected',
  simulated: 'Demo',
  error: 'Disconnected',
  loading: 'Connecting',
};

function TopBar({
  telemetry,
  leaseStatus,
  onLeaveLease,
}: {
  telemetry: RoboClawTelemetry | null;
  leaseStatus: QueueStatus | null;
  onLeaveLease: () => void;
}) {
  return (
    <header className="topbar">
      <a className="topbar-brand" href={BRAND.homepage} target="_blank" rel="noreferrer">
        <img src={BRAND.logoUrl} alt={BRAND.name} className="brand-logo" />
        <div className="brand-text">
          <h1>{BRAND.name}</h1>
          <p className="topbar-sub">{BRAND.tagline}</p>
        </div>
      </a>
      <div className="topbar-status">
        {leaseStatus && <LeaseChip status={leaseStatus} onLeave={onLeaveLease} />}
        <StatusPill telemetry={telemetry} />
        <span className="topbar-time" title="Time at the telescope (UTC)">
          <span className="topbar-time-label">Telescope time</span>
          {telemetry
            ? `${new Date(telemetry.timestamp * 1000).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false })} UTC`
            : '—'}
        </span>
      </div>
    </header>
  );
}

function StatusPill({ telemetry }: { telemetry: RoboClawTelemetry | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const mode = telemetry?.connection?.mode ?? 'loading';
  const poll = telemetry?.poll;

  let pollLevel: 'ok' | 'warn' | 'bad' = 'ok';
  if (poll) {
    const ageMs = poll.last_tick_age_s != null ? poll.last_tick_age_s * 1000 : null;
    const staleThresholdMs = (1000 / poll.target_hz) * 2;
    const isStale = ageMs != null && ageMs > staleThresholdMs;
    if (isStale || poll.actual_hz == null) pollLevel = 'bad';
    else if (poll.actual_hz < poll.target_hz * 0.7) pollLevel = 'warn';
    else if (poll.actual_hz < poll.target_hz * 0.4) pollLevel = 'bad';
  }

  const dotLevel = mode === 'error' ? 'bad' : mode === 'loading' ? 'loading' : pollLevel;

  return (
    <span className={`status-pill status-pill-${dotLevel}`}>
      <span className="poll-dot" />
      {MODE_LABEL[mode] ?? mode}
      <span className="status-pill-popover">
        <span className="status-pill-row">
          <span className="status-pill-key">Connection</span>
          <span className="status-pill-val">{mode}</span>
        </span>
        {poll && (
          <>
            <span className="status-pill-row">
              <span className="status-pill-key">Poll rate</span>
              <span className="status-pill-val">
                {poll.actual_hz != null ? `${poll.actual_hz.toFixed(1)} Hz` : '— Hz'}
                <span className="status-pill-muted"> / {poll.target_hz} Hz target</span>
              </span>
            </span>
            {poll.last_tick_age_s != null && (
              <span className="status-pill-row">
                <span className="status-pill-key">Last tick</span>
                <span className="status-pill-val">{poll.last_tick_age_s.toFixed(1)} s ago</span>
              </span>
            )}
          </>
        )}
      </span>
    </span>
  );
}

// ─── Panel header ─────────────────────────────────────────────────────────────

function PanelHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <h2 className="panel-header">
      <span className="panel-header-icon">{icon}</span>
      {title}
    </h2>
  );
}

function ControllerIssueBanner({ issue }: { issue: ControllerIssue | null }) {
  if (!issue) return null;

  return (
    <div className="banner banner-error banner-column">
      <div className="banner-main">
        <AlertTriangle size={14} />
        <strong>{issue.title}</strong>
        <span>{issue.summary}</span>
      </div>
      <span className="banner-detail">{issue.action}</span>
    </div>
  );
}

function ErrorLog({ entries, onClear }: { entries: ErrorLogEntry[]; onClear: () => void }) {
  if (entries.length === 0) return null;

  return (
    <details className="error-log">
      <summary>
        <span>Connection issues</span>
        <strong>{entries.length}</strong>
      </summary>
      <div className="error-log-body">
        <button type="button" className="error-log-clear" onClick={onClear}>Clear</button>
        {entries.map((entry) => (
          <div className="error-log-entry" key={entry.id}>
            <div className="error-log-meta">
              <strong>{entry.source}</strong>
              <span>{entry.lastSeen.toLocaleTimeString()}</span>
              {entry.count > 1 && <span>{entry.count}x</span>}
            </div>
            <code>{entry.message}</code>
          </div>
        ))}
      </div>
    </details>
  );
}

// ─── Telescope controls ───────────────────────────────────────────────────────

function TelescopeControls({ telemetry, runCommand, stopAll, gotoAltAz, targetAz, targetAlt, setTargetAz, setTargetAlt }: {
  telemetry: RoboClawTelemetry | null;
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
  stopAll: () => Promise<void>;
  gotoAltAz: (alt: number, az: number) => Promise<void>;
  targetAz: number;
  targetAlt: number;
  setTargetAz: (v: number) => void;
  setTargetAlt: (v: number) => void;
}) {
  const [slewSpeed, setSlewSpeed] = useState(40);
  const speed = Math.round(slewSpeed * 127 / 100);

  const submitTarget = async (e: FormEvent) => {
    e.preventDefault();
    await gotoAltAz(targetAlt, targetAz);
  };

  return (
    <>
      <PanelHeader icon={<Gauge size={14} />} title="Pointing" />
      <div className="controls-grid">
        <AxisControl
          title="Azimuth"
          negativeLabel="West"
          positiveLabel="East"
          negativeIcon={<ChevronLeft size={20} />}
          positiveIcon={<ChevronRight size={20} />}
          motor={telemetry?.motors.m1}
          onNegativeStart={() => runCommand('backward_m1', { speed })}
          onNegativeStop={() => runCommand('backward_m1', { speed: 0 })}
          onPositiveStart={() => runCommand('forward_m1', { speed })}
          onPositiveStop={() => runCommand('forward_m1', { speed: 0 })}
        />
        <AxisControl
          title="Elevation"
          negativeLabel="Down"
          positiveLabel="Up"
          negativeIcon={<ChevronDown size={20} />}
          positiveIcon={<ChevronUp size={20} />}
          motor={telemetry?.motors.m2}
          onNegativeStart={() => runCommand('backward_m2', { speed })}
          onNegativeStop={() => runCommand('backward_m2', { speed: 0 })}
          onPositiveStart={() => runCommand('forward_m2', { speed })}
          onPositiveStop={() => runCommand('forward_m2', { speed: 0 })}
        />
        <div className="speed-control">
          <label>
            <span>Slew speed</span>
            <strong>{slewSpeed}%</strong>
            <input type="range" min={1} max={100} value={slewSpeed} onChange={(e) => setSlewSpeed(Number(e.target.value))} />
          </label>
          <button className="stop-button" onClick={() => void stopAll()}>
            <Square size={14} fill="currentColor" /> Stop
          </button>
        </div>
        <form className="target-form" onSubmit={submitTarget}>
          <label><span>Azimuth °</span><input type="number" min={0} max={360} step={0.001} value={targetAz} onChange={(e) => setTargetAz(Number(e.target.value))} /></label>
          <label><span>Altitude °</span><input type="number" min={0} max={90} step={0.001} value={targetAlt} onChange={(e) => setTargetAlt(Number(e.target.value))} /></label>
          <button type="submit" className="action-button"><Navigation size={14} /> Slew </button>
        </form>
      </div>
    </>
  );
}

// ─── Admin panel ─────────────────────────────────────────────────────────────

function AdminPanel({ syncAltAz, homeElevation, zeroAzimuth, zeroAltitude, targetAz, targetAlt }: {
  syncAltAz: (alt: number, az: number) => Promise<void>;
  homeElevation: () => Promise<void>;
  zeroAzimuth: () => Promise<void>;
  zeroAltitude: () => Promise<void>;
  targetAz: number;
  targetAlt: number;
}) {
  const [elHoming, setElHoming] = useState(false);

  const runHomeElevation = async () => {
    setElHoming(true);
    try { await homeElevation(); } finally { setElHoming(false); }
  };

  return (
    <details className="admin-panel">
      <summary className="admin-panel-summary">
        <Cpu size={13} /> Calibration &amp; Homing
      </summary>
      <div className="admin-panel-body">
        <div className="admin-row">
          <span className="admin-label">Position offset</span>
          <button
            type="button"
            onClick={() => void syncAltAz(targetAlt, targetAz)}
            title="Recalibrates the alt/az zero offsets so the controller reports the current target coordinates. Does not move the dish."
          >
            <Crosshair size={13} /> Set as Current
          </button>
        </div>
        <div className="admin-row">
          <span className="admin-label">Elevation home</span>
          <button
            onClick={() => void runHomeElevation()}
            disabled={elHoming}
            className={elHoming ? 'homing-active' : ''}
            title="Slowly lowers the dish until it hits the bottom stop, then resets the elevation encoder to zero"
          >
            <Home size={13} />
            {elHoming ? 'Homing…' : 'Home Elevation'}
          </button>
        </div>
        <div className="admin-row">
          <span className="admin-label">Azimuth zero</span>
          <button
            onClick={() => void zeroAzimuth()}
            title="Sets the current azimuth position as the zero reference point"
          >
            <Crosshair size={13} /> Zero Azimuth
          </button>
        </div>
        <div className="admin-row">
          <span className="admin-label">Altitude zero</span>
          <button
            onClick={() => void zeroAltitude()}
            title="Zeros the M2 encoder register at the current position. Reported altitude follows the calibration; any prior sync offset is preserved."
          >
            <Crosshair size={13} /> Zero Altitude
          </button>
        </div>
      </div>
    </details>
  );
}

// ─── PID tuning ───────────────────────────────────────────────────────────────

const POSITION_FIELDS = ['p', 'i', 'd', 'i_max', 'deadzone', 'min', 'max'] as const;
const VELOCITY_FIELDS = ['p', 'i', 'd', 'qpps'] as const;
type PositionField = (typeof POSITION_FIELDS)[number];
type VelocityField = (typeof VELOCITY_FIELDS)[number];

const POSITION_LABELS: Record<PositionField, string> = {
  p: 'P', i: 'I', d: 'D', i_max: 'Max I', deadzone: 'Deadzone', min: 'Min Pos', max: 'Max Pos',
};
const VELOCITY_LABELS: Record<VelocityField, string> = {
  p: 'P', i: 'I', d: 'D', qpps: 'QPPS',
};

// RoboClaw stores P/I/D as fixed-point integers; BasicMicro Motion Studio
// (and most users) work in the floating-point form. Position is Q22.10
// (×1024); velocity is Q16.16 (×65536). Other fields are plain integers.
const POSITION_SCALE: Record<PositionField, number> = {
  p: 1024, i: 1024, d: 1024, i_max: 1024, deadzone: 1, min: 1, max: 1,
};
const VELOCITY_SCALE: Record<VelocityField, number> = {
  p: 65536, i: 65536, d: 65536, qpps: 1,
};

function emptyPosition(): Record<PositionField, number> {
  return { p: 0, i: 0, d: 0, i_max: 0, deadzone: 0, min: 0, max: 0 };
}
function emptyVelocity(): Record<VelocityField, number> {
  return { p: 0, i: 0, d: 0, qpps: 0 };
}

function PidTuningPanel({ onNotice }: { onNotice: (msg: string | null) => void }) {
  const [m1Pos, setM1Pos] = useState(emptyPosition);
  const [m2Pos, setM2Pos] = useState(emptyPosition);
  const [m1Vel, setM1Vel] = useState(emptyVelocity);
  const [m2Vel, setM2Vel] = useState(emptyVelocity);
  const [busy, setBusy] = useState(false);

  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    onNotice(null);
    try { return await fn(); }
    catch (err) { onNotice(`${label}: ${errorMessage(err)}`); return null; }
    finally { setBusy(false); }
  };

  const readPosition = (motor: 'm1' | 'm2') => async () => {
    const r = await run(`Read ${motor} position PID`, () => api.execute(`read_${motor}_position_pid`, {}));
    if (!r?.ok) return;
    const raw = { ...emptyPosition(), ...(r.response as Record<PositionField, number>) };
    const next = Object.fromEntries(
      POSITION_FIELDS.map((k) => [k, raw[k] / POSITION_SCALE[k]]),
    ) as Record<PositionField, number>;
    (motor === 'm1' ? setM1Pos : setM2Pos)(next);
  };

  const readVelocity = (motor: 'm1' | 'm2') => async () => {
    const r = await run(`Read ${motor} velocity PID`, () => api.execute(`read_${motor}_velocity_pid`, {}));
    if (!r?.ok) return;
    const raw = { ...emptyVelocity(), ...(r.response as Record<VelocityField, number>) };
    const next = Object.fromEntries(
      VELOCITY_FIELDS.map((k) => [k, raw[k] / VELOCITY_SCALE[k]]),
    ) as Record<VelocityField, number>;
    (motor === 'm1' ? setM1Vel : setM2Vel)(next);
  };

  const writePosition = (motor: 'm1' | 'm2', values: Record<PositionField, number>) => async () => {
    if (!confirm(`Write Position PID to ${motor.toUpperCase()}? This changes controller flash settings.`)) return;
    const scaled = Object.fromEntries(
      POSITION_FIELDS.map((k) => [k, Math.round(values[k] * POSITION_SCALE[k])]),
    ) as Record<PositionField, number>;
    await run(`Write ${motor} position PID`, () => api.execute(`set_${motor}_position_pid`, scaled));
  };

  const writeVelocity = (motor: 'm1' | 'm2', values: Record<VelocityField, number>) => async () => {
    if (!confirm(`Write Velocity PID to ${motor.toUpperCase()}? This changes controller flash settings.`)) return;
    const scaled = Object.fromEntries(
      VELOCITY_FIELDS.map((k) => [k, Math.round(values[k] * VELOCITY_SCALE[k])]),
    ) as Record<VelocityField, number>;
    await run(`Write ${motor} velocity PID`, () => api.execute(`set_${motor}_velocity_pid`, scaled));
  };

  return (
    <details className="admin-panel">
      <summary className="admin-panel-summary">
        <Cpu size={13} /> PID Tuning
      </summary>
      <div className="admin-panel-body">
        <p className="admin-panel-note">
          Reads from / writes to the RoboClaw flash. Values persist across power cycles.
          Use with care — incorrect PID can cause runaway motion.
        </p>
        <PidAxis
          title="M1 — Azimuth"
          position={m1Pos} setPosition={setM1Pos}
          velocity={m1Vel} setVelocity={setM1Vel}
          onReadPos={readPosition('m1')} onWritePos={writePosition('m1', m1Pos)}
          onReadVel={readVelocity('m1')} onWriteVel={writeVelocity('m1', m1Vel)}
          busy={busy}
        />
        <PidAxis
          title="M2 — Altitude"
          position={m2Pos} setPosition={setM2Pos}
          velocity={m2Vel} setVelocity={setM2Vel}
          onReadPos={readPosition('m2')} onWritePos={writePosition('m2', m2Pos)}
          onReadVel={readVelocity('m2')} onWriteVel={writeVelocity('m2', m2Vel)}
          busy={busy}
        />
      </div>
    </details>
  );
}

function PidAxis({
  title, position, setPosition, velocity, setVelocity,
  onReadPos, onWritePos, onReadVel, onWriteVel, busy,
}: {
  title: string;
  position: Record<PositionField, number>;
  setPosition: (v: Record<PositionField, number>) => void;
  velocity: Record<VelocityField, number>;
  setVelocity: (v: Record<VelocityField, number>) => void;
  onReadPos: () => Promise<void>;
  onWritePos: () => Promise<void>;
  onReadVel: () => Promise<void>;
  onWriteVel: () => Promise<void>;
  busy: boolean;
}) {
  return (
    <div className="pid-axis">
      <div className="pid-axis-title">{title}</div>
      <div className="pid-section">
        <div className="pid-section-header">
          <span>Position</span>
          <div className="pid-section-actions">
            <button type="button" disabled={busy} onClick={() => void onReadPos()} title="Read from controller">
              <Download size={12} /> Read
            </button>
            <button type="button" disabled={busy} onClick={() => void onWritePos()} title="Write to controller flash">
              <Upload size={12} /> Write
            </button>
          </div>
        </div>
        <div className="pid-fields">
          {POSITION_FIELDS.map((k) => (
            <label key={k}>
              <span>{POSITION_LABELS[k]}</span>
              <input
                type="number"
                step="any"
                value={position[k]}
                onChange={(e) => setPosition({ ...position, [k]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="pid-section">
        <div className="pid-section-header">
          <span>Velocity</span>
          <div className="pid-section-actions">
            <button type="button" disabled={busy} onClick={() => void onReadVel()} title="Read from controller">
              <Download size={12} /> Read
            </button>
            <button type="button" disabled={busy} onClick={() => void onWriteVel()} title="Write to controller flash">
              <Upload size={12} /> Write
            </button>
          </div>
        </div>
        <div className="pid-fields">
          {VELOCITY_FIELDS.map((k) => (
            <label key={k}>
              <span>{VELOCITY_LABELS[k]}</span>
              <input
                type="number"
                step="any"
                value={velocity[k]}
                onChange={(e) => setVelocity({ ...velocity, [k]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Axis control ─────────────────────────────────────────────────────────────

// RoboClaw's firmware serial-timeout failsafe stops the motors if no command
// arrives within ~1 s. Re-issuing the drive command at this cadence is safely
// inside that window while still being light on the bus.
const JOG_REPEAT_MS = 200;

function AxisControl({ title, negativeLabel, positiveLabel, negativeIcon, positiveIcon, motor, onNegativeStart, onNegativeStop, onPositiveStart, onPositiveStop }: {
  title: string;
  negativeLabel: string;
  positiveLabel: string;
  negativeIcon: React.ReactNode;
  positiveIcon: React.ReactNode;
  motor: MotorSnapshot | undefined;
  onNegativeStart: () => Promise<void>;
  onNegativeStop: () => Promise<void>;
  onPositiveStart: () => Promise<void>;
  onPositiveStop: () => Promise<void>;
}) {
  const currentCls = currentClass(motor?.current_a);
  const negativeJog = useJog(onNegativeStart, onNegativeStop);
  const positiveJog = useJog(onPositiveStart, onPositiveStop);

  return (
    <div className="axis-compact">
      <div className="axis-title">
        <h2>{title}</h2>
        <span className={`axis-current ${currentCls}`}>
          {motor?.current_a == null ? '—' : `${motor.current_a.toFixed(2)} A`}
        </span>
      </div>
      <div className="axis-actions">
        <button type="button" {...negativeJog} className={negativeJog.active ? 'jog-active' : ''}>{negativeIcon}{negativeLabel}</button>
        <button type="button" {...positiveJog} className={positiveJog.active ? 'jog-active' : ''}>{positiveIcon}{positiveLabel}</button>
      </div>
      <DenseReadout rows={[
        ['PWM output',       value(motor?.pwm)],
        ['Encoder position', encoder(motor?.encoder)],
        ['Encoder speed',    qpps(motor?.speed_qpps)],
      ]} />
    </div>
  );
}

// Hook: turn a button into a press-and-hold jog. Reissues `start` every
// JOG_REPEAT_MS while pressed, sends `stop` on release / pointer-leave /
// cancel / unmount. We avoid setPointerCapture so dragging off the button
// is treated as a release (matches what the user sees on touch too).
function useJog(start: () => Promise<void>, stop: () => Promise<void>) {
  const [active, setActive] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Stash the latest callbacks so the interval always fires the current one
  // even though we only set it up once per press.
  const startRef = useRef(start);
  const stopRef = useRef(stop);
  startRef.current = start;
  stopRef.current = stop;

  const end = useCallback(() => {
    if (timerRef.current == null) return;
    window.clearInterval(timerRef.current);
    timerRef.current = null;
    setActive(false);
    void stopRef.current();
  }, []);

  const begin = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left-click only on mouse
    if (timerRef.current != null) return;
    setActive(true);
    void startRef.current();
    timerRef.current = window.setInterval(() => { void startRef.current(); }, JOG_REPEAT_MS);
  }, []);

  // If the component unmounts mid-press (e.g. queue revokes control and the
  // page swaps to the spectator view), make sure we stop the motor.
  useEffect(() => () => { if (timerRef.current != null) { window.clearInterval(timerRef.current); void stopRef.current(); } }, []);

  return {
    active,
    onPointerDown: begin,
    onPointerUp: end,
    onPointerLeave: end,
    onPointerCancel: end,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  } as const;
}

// ─── Telemetry dashboard ─────────────────────────────────────────────────────

function TelemetryDashboard({ telemetry }: { telemetry: RoboClawTelemetry | null }) {
  return (
    <>
      <PanelHeader icon={<Activity size={14} />} title="Status" />
      <div className="telemetry-dense">
        <DenseReadout title="Power" icon={<Zap size={11} />} rows={[
          ['Battery',     volts(telemetry?.main_battery_v),   voltClass(telemetry?.main_battery_v)],
          ['Electronics', volts(telemetry?.logic_battery_v),  voltClass(telemetry?.logic_battery_v)],
        ]} />
        <DenseReadout title="Temperature" icon={<Thermometer size={11} />} rows={[
          ['Controller', celsius(telemetry?.temperature_c),   tempClass(telemetry?.temperature_c)],
          ['Driver',     celsius(telemetry?.temperature_2_c), tempClass(telemetry?.temperature_2_c)],
        ]} />
        <DenseReadout title="Raspberry Pi" icon={<Cpu size={11} />} rows={[
          ['CPU temp', celsius(telemetry?.host.cpu_temp_c), tempClass(telemetry?.host.cpu_temp_c)],
          ['CPU load', load(telemetry)],
          ['Memory',   percent(telemetry?.host.memory_used_percent)],
          ['Disk',     disk(telemetry)],
          ['Uptime',   duration(telemetry?.host.uptime_s)],
        ]} />
        <DenseReadout title="Azimuth Motor" rows={[
          ['Encoder position', encoder(telemetry?.motors.m1?.encoder)],
          ['Encoder speed',    qpps(telemetry?.motors.m1?.speed_qpps)],
          ['PWM output',       value(telemetry?.motors.m1?.pwm)],
          ['Motor current',    telemetry?.motors.m1?.current_a == null ? '—' : `${telemetry.motors.m1.current_a.toFixed(2)} A`],
        ]} />
        <DenseReadout title="Elevation Motor" rows={[
          ['Encoder position', encoder(telemetry?.motors.m2?.encoder)],
          ['Encoder speed',    qpps(telemetry?.motors.m2?.speed_qpps)],
          ['PWM output',       value(telemetry?.motors.m2?.pwm)],
          ['Motor current',    telemetry?.motors.m2?.current_a == null ? '—' : `${telemetry.motors.m2.current_a.toFixed(2)} A`],
        ]} />
      </div>
    </>
  );
}

// ─── Dense readout ────────────────────────────────────────────────────────────

type ReadoutRow = [label: string, value: string, valueClass?: string];

function DenseReadout({ title, icon, rows }: { title?: string; icon?: React.ReactNode; rows: ReadoutRow[] }) {
  return (
    <div className="dense-readout">
      {title && (
        <h3>
          {icon && <span className="readout-icon">{icon}</span>}
          {title}
        </h3>
      )}
      <dl>
        {rows.map(([label, val, cls]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd className={cls ?? ''}>{val}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function value(input: number | null | undefined): string {
  return input == null ? '—' : String(input);
}

function encoder(input: number | null | undefined): string {
  return input == null ? '—' : input.toLocaleString();
}

function volts(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(2)} V`;
}

function celsius(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(1)} °C`;
}

function qpps(input: number | null | undefined): string {
  return input == null ? '—' : input.toLocaleString();
}

function percent(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(1)}%`;
}

function load(telemetry: RoboClawTelemetry | null): string {
  const host = telemetry?.host;
  if (!host || host.load_1m == null) return '—';
  const cores = host.cpu_count ? ` / ${host.cpu_count}c` : '';
  return `${host.load_1m.toFixed(2)}${cores}`;
}

function disk(telemetry: RoboClawTelemetry | null): string {
  const host = telemetry?.host;
  if (!host || host.disk_used_percent == null || host.disk_free_gb == null) return '—';
  return `${host.disk_used_percent.toFixed(1)}% · ${host.disk_free_gb.toFixed(1)} GB free`;
}

function duration(input: number | null | undefined): string {
  if (input == null) return '—';
  const mins = Math.floor(input / 60);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ─── Status classifiers ──────────────────────────────────────────────────────

function voltClass(v: number | null | undefined): string {
  if (v == null) return '';
  if (v < 10) return 'val-crit';
  if (v < 11.5) return 'val-warn';
  return 'val-ok';
}

function tempClass(c: number | null | undefined): string {
  if (c == null) return '';
  if (c > 75) return 'val-crit';
  if (c > 60) return 'val-warn';
  return '';
}

function currentClass(a: number | null | undefined): string {
  if (a == null) return '';
  if (a > 5) return 'val-crit';
  if (a > 3) return 'val-warn';
  return '';
}

function explainControllerError(message: string | null): ControllerIssue | null {
  if (!message) return null;
  const lower = message.toLowerCase();
  const hasSerialTimeout = lower.includes('serial timeout');
  const hasCrcMismatch = lower.includes('crc mismatch');

  if (hasSerialTimeout || hasCrcMismatch) {
    return {
      title: 'Connection to the motor controller is unstable.',
      summary: "The telescope isn't responding to commands reliably.",
      action: 'Check that all cables between the Raspberry Pi and the motor controller are secure and fully seated.',
    };
  }

  if (lower.includes('missing ack')) {
    return {
      title: 'The motor controller didn\'t respond to a command.',
      summary: 'A movement command was sent but the controller did not confirm it.',
      action: 'Check that the controller is powered on and the USB cable is connected firmly.',
    };
  }

  return {
    title: 'The motor controller reported a problem.',
    summary: 'Something unexpected happened while communicating with the telescope.',
    action: 'Expand "Connection issues" below for details. Try refreshing the page if the problem persists.',
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
