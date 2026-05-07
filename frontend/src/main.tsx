import './styles/main.css';

import {
  Activity, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Cpu, Crosshair, Gauge, Home, LogOut, Map, Navigation, Square,
  Thermometer, Zap,
} from 'lucide-react';
import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api, ApiError } from './api';
import { BRAND } from './branding';
import { SkyMap } from './components/SkyMap';
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
    return () => ws.close();
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
      <TopBar telemetry={telemetry} />

      {queueEnabled && queueStatus && queueStatus.is_active && (
        <LeaseBanner status={queueStatus} onLeave={() => void handleLeave()} />
      )}

      {telemetry?.connection.mode !== 'serial' && (
        <div className={`banner ${telemetry?.connection.mode === 'error' ? 'banner-error' : ''}`}>
          <AlertTriangle size={14} />
          <span>{telemetry?.connection.mode === 'error'
            ? 'Lost connection to the telescope. Check that all cables are secure and try refreshing.'
            : 'No telescope hardware detected — running in demo mode. Controls will not move anything.'}</span>
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
          <TelescopeControls telemetry={telemetry} runCommand={runCommand} stopAll={stopAll} gotoAltAz={gotoAltAz} syncAltAz={syncAltAz} homeElevation={homeElevation} zeroAzimuth={zeroAzimuth} targetAz={targetAz} targetAlt={targetAlt} setTargetAz={setTargetAz} setTargetAlt={setTargetAlt} />
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

function LeaseBanner({ status, onLeave }: { status: QueueStatus; onLeave: () => void }) {
  const remaining = Math.max(0, Math.round(status.lease_remaining_s ?? 0));
  const idle = status.idle_remaining_s == null ? null : Math.max(0, Math.round(status.idle_remaining_s));
  return (
    <div className="banner banner-ok lease-banner">
      <Activity size={14} />
      <span>You are in control. Time remaining: <strong>{formatSeconds(remaining)}</strong>
        {idle != null && idle < 30 && <> · idle release in <strong>{idle}s</strong></>}
      </span>
      <button className="lease-leave" onClick={onLeave}><LogOut size={12} /> Release control</button>
    </div>
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

function TopBar({ telemetry }: { telemetry: RoboClawTelemetry | null }) {
  const conn = telemetry?.connection;
  const mode = conn?.mode ?? 'loading';

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
        <PollIndicator telemetry={telemetry} />
        <span className={`mode mode-${mode}`}>{MODE_LABEL[mode] ?? mode}</span>
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

function PollIndicator({ telemetry }: { telemetry: RoboClawTelemetry | null }) {
  // Force a re-render every second so the staleness age stays current even
  // when no telemetry message has arrived.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const poll = telemetry?.poll;
  if (!poll) return null;

  const target = poll.target_hz;
  const actual = poll.actual_hz;
  const ageMs = poll.last_tick_age_s != null ? poll.last_tick_age_s * 1000 : null;

  // "stale" if no tick in 2 target intervals
  const staleThresholdMs = (1000 / target) * 2;
  const isStale = ageMs != null && ageMs > staleThresholdMs;

  let level: 'ok' | 'warn' | 'bad' = 'ok';
  if (isStale || actual == null) level = 'bad';
  else if (actual < target * 0.7) level = 'warn';
  else if (actual < target * 0.4) level = 'bad';

  const display = actual != null ? `${actual.toFixed(1)} Hz` : '— Hz';
  const tooltip = `Poll loop: ${actual != null ? actual.toFixed(2) : '—'} Hz (target ${target} Hz)` +
    (ageMs != null ? ` · last tick ${(ageMs / 1000).toFixed(1)} s ago` : '');

  return (
    <span className={`poll-indicator poll-${level}`} title={tooltip}>
      <span className="poll-dot" />
      {display}
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

function TelescopeControls({ telemetry, runCommand, stopAll, gotoAltAz, syncAltAz, homeElevation, zeroAzimuth, targetAz, targetAlt, setTargetAz, setTargetAlt }: {
  telemetry: RoboClawTelemetry | null;
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
  stopAll: () => Promise<void>;
  gotoAltAz: (alt: number, az: number) => Promise<void>;
  syncAltAz: (alt: number, az: number) => Promise<void>;
  homeElevation: () => Promise<void>;
  zeroAzimuth: () => Promise<void>;
  targetAz: number;
  targetAlt: number;
  setTargetAz: (v: number) => void;
  setTargetAlt: (v: number) => void;
}) {
  const [slewSpeed, setSlewSpeed] = useState(40);
  const [elHoming, setElHoming] = useState(false);
  const speed = Math.round(slewSpeed * 127 / 100);

  const submitTarget = async (e: FormEvent) => {
    e.preventDefault();
    await gotoAltAz(targetAlt, targetAz);
  };

  const runHomeElevation = async () => {
    setElHoming(true);
    try { await homeElevation(); } finally { setElHoming(false); }
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
          negative={() => runCommand('backward_m1', { speed })}
          positive={() => runCommand('forward_m1', { speed })}
        />
        <AxisControl
          title="Elevation"
          negativeLabel="Down"
          positiveLabel="Up"
          negativeIcon={<ChevronDown size={20} />}
          positiveIcon={<ChevronUp size={20} />}
          motor={telemetry?.motors.m2}
          negative={() => runCommand('backward_m2', { speed })}
          positive={() => runCommand('forward_m2', { speed })}
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
          <button type="submit" className="action-button"><Navigation size={14} /> Slew Here</button>
          <button
            type="button"
            className="action-button"
            onClick={() => void syncAltAz(targetAlt, targetAz)}
            title="Testing only — recalibrates the alt/az zero offsets so the controller reports this position. Does not move the dish or touch the encoders."
          >
            <Crosshair size={14} /> Set as Current
          </button>
        </form>
        <div className="homing-bar">
          <span className="homing-label">Calibrate</span>
          <button
            onClick={() => void runHomeElevation()}
            disabled={elHoming}
            className={elHoming ? 'homing-active' : ''}
            title="Slowly lowers the dish until it hits the bottom stop, then resets the elevation encoder to zero"
          >
            <Home size={14} />
            {elHoming ? 'Homing elevation…' : 'Home Elevation'}
          </button>
          <button
            onClick={() => void zeroAzimuth()}
            title="Sets the current azimuth position as the zero reference point"
          >
            <Crosshair size={14} /> Zero Azimuth
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Axis control ─────────────────────────────────────────────────────────────

function AxisControl({ title, negativeLabel, positiveLabel, negativeIcon, positiveIcon, motor, negative, positive }: {
  title: string;
  negativeLabel: string;
  positiveLabel: string;
  negativeIcon: React.ReactNode;
  positiveIcon: React.ReactNode;
  motor: MotorSnapshot | undefined;
  negative: () => Promise<void>;
  positive: () => Promise<void>;
}) {
  const currentCls = currentClass(motor?.current_a);

  return (
    <div className="axis-compact">
      <div className="axis-title">
        <h2>{title}</h2>
        <span className={`axis-current ${currentCls}`}>
          {motor?.current_a == null ? '—' : `${motor.current_a.toFixed(2)} A`}
        </span>
      </div>
      <div className="axis-actions">
        <button onClick={() => void negative()}>{negativeIcon}{negativeLabel}</button>
        <button onClick={() => void positive()}>{positiveIcon}{positiveLabel}</button>
      </div>
      <DenseReadout rows={[
        ['PWM output',       value(motor?.pwm)],
        ['Encoder position', encoder(motor?.encoder)],
        ['Encoder speed',    qpps(motor?.speed_qpps)],
      ]} />
    </div>
  );
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
