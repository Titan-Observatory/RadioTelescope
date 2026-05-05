import './styles/main.css';
import '@xterm/xterm/css/xterm.css';

import {
  Activity, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Cpu, Crosshair, Gauge, Home, Map, Navigation, Radio, RotateCcw, Save, Sliders, Square,
  Terminal as TerminalIcon, Thermometer, Zap,
} from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api, ApiError } from './api';
import { SkyMap } from './components/SkyMap';
import type { CommandInfo, MotorSnapshot, RoboClawTelemetry, TelescopeConfig } from './types';

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

  useEffect(() => {
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

  const gotoAltAz = async (altDeg: number, azDeg: number, speedQpps: number, accelQpps2: number) => {
    setNotice(null);
    try {
      await api.gotoAltAz(altDeg, azDeg, speedQpps, accelQpps2);
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

  const flags = telemetry?.status_flags ?? [];
  const controllerIssue = explainControllerError(telemetry?.last_error ?? null);

  return (
    <div className="app-shell">
      <TopBar telemetry={telemetry} stopAll={stopAll} />

      {telemetry?.connection.mode !== 'serial' && (
        <div className={`banner ${telemetry?.connection.mode === 'error' ? 'banner-error' : ''}`}>
          <AlertTriangle size={14} />
          <span>{telemetry?.connection.message ?? 'Using simulated RoboClaw data — no hardware connected.'}</span>
        </div>
      )}

      {flags.length > 0 && (
        <div className="banner banner-warn">
          <AlertTriangle size={14} />
          <span>Controller flags: {flags.join(', ')}</span>
        </div>
      )}

      {telemetry?.last_error && (
        <ControllerIssueBanner issue={controllerIssue} />
      )}

      {notice && (
        <div className={`banner ${notice.startsWith('Elevation homed') || notice.startsWith('Azimuth') ? 'banner-ok' : 'banner-error'}`}>
          <AlertTriangle size={14} />
          <span>{notice}</span>
        </div>
      )}

      <ErrorLog entries={errorLog} onClear={() => setErrorLog([])} />

      <main className="dashboard">
        <section className="panel controls-panel">
          <TelescopeControls telemetry={telemetry} runCommand={runCommand} stopAll={stopAll} gotoAltAz={gotoAltAz} homeElevation={homeElevation} zeroAzimuth={zeroAzimuth} />
        </section>
        <section className="panel tune-panel">
          <LiveTuning runCommand={runCommand} />
        </section>
        <section className="panel skymap-panel">
          <PanelHeader icon={<Map size={14} />} title="Sky Map" />
          <SkyMap telemetry={telemetry} config={telescopeConfig} onNotice={setNotice} />
        </section>
        <section className="panel telemetry-panel">
          <TelemetryDashboard telemetry={telemetry} />
        </section>
        <section className="panel terminal-panel">
          <HostTerminal />
        </section>
      </main>
    </div>
  );
}

// ─── TopBar ──────────────────────────────────────────────────────────────────

function TopBar({ telemetry, stopAll }: { telemetry: RoboClawTelemetry | null; stopAll: () => Promise<void> }) {
  const conn = telemetry?.connection;
  const subtitle = conn
    ? `${conn.port} · ${conn.baudrate.toLocaleString()} baud · 0x${conn.address.toString(16).toUpperCase()}${telemetry?.firmware ? ` · fw ${telemetry.firmware}` : ''}`
    : 'Connecting…';

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Radio size={18} className="brand-icon" />
        <div>
          <h1>RoboClaw Telescope Control</h1>
          <p className="topbar-sub">{subtitle}</p>
        </div>
      </div>
      <div className="topbar-status">
        <span className={`mode mode-${conn?.mode ?? 'simulated'}`}>{conn?.mode ?? 'loading'}</span>
        <span className="topbar-time">{telemetry ? new Date(telemetry.timestamp * 1000).toLocaleTimeString() : '—'}</span>
        <button className="stop-button estop-button" onClick={() => void stopAll()} title="Emergency stop — halts both motors immediately">
          <Square size={15} fill="currentColor" /> E-Stop
        </button>
      </div>
    </header>
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
        <span>Recent errors</span>
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

function TelescopeControls({ telemetry, runCommand, stopAll, gotoAltAz, homeElevation, zeroAzimuth }: {
  telemetry: RoboClawTelemetry | null;
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
  stopAll: () => Promise<void>;
  gotoAltAz: (alt: number, az: number, speed: number, accel: number) => Promise<void>;
  homeElevation: () => Promise<void>;
  zeroAzimuth: () => Promise<void>;
}) {
  const [slewSpeed, setSlewSpeed] = useState(40);
  const [targetAz, setTargetAz] = useState(0);
  const [targetAlt, setTargetAlt] = useState(45);
  const [targetSpeed, setTargetSpeed] = useState(10_000);
  const [targetAccel, setTargetAccel] = useState(25_000);
  const [elHoming, setElHoming] = useState(false);
  const speed = Math.round(slewSpeed * 127 / 100);

  const submitTarget = async (e: FormEvent) => {
    e.preventDefault();
    await gotoAltAz(targetAlt, targetAz, targetSpeed, targetAccel);
  };

  const runHomeElevation = async () => {
    setElHoming(true);
    try { await homeElevation(); } finally { setElHoming(false); }
  };

  return (
    <>
      <PanelHeader icon={<Gauge size={14} />} title="Telescope Controls" />
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
            <span>Slew</span>
            <strong>{slewSpeed}%</strong>
            <input type="range" min={1} max={100} value={slewSpeed} onChange={(e) => setSlewSpeed(Number(e.target.value))} />
          </label>
          <button className="stop-button" onClick={() => void stopAll()}>
            <Square size={14} fill="currentColor" /> Stop
          </button>
        </div>
        <form className="target-form" onSubmit={submitTarget}>
          <label><span>Azimuth °</span><input type="number" min={0} max={360} step={0.01} value={targetAz} onChange={(e) => setTargetAz(Number(e.target.value))} /></label>
          <label><span>Altitude °</span><input type="number" min={0} max={90} step={0.01} value={targetAlt} onChange={(e) => setTargetAlt(Number(e.target.value))} /></label>
          <label><span>Speed (QPPS)</span><input type="number" min={0} max={4_294_967_295} value={targetSpeed} onChange={(e) => setTargetSpeed(Number(e.target.value))} /></label>
          <label><span>Accel (QPPS²)</span><input type="number" min={0} max={4_294_967_295} value={targetAccel} onChange={(e) => setTargetAccel(Number(e.target.value))} /></label>
          <button type="submit" className="action-button"><Navigation size={14} /> Go To</button>
        </form>
        <div className="homing-bar">
          <span className="homing-label">Homing</span>
          <button
            onClick={() => void runHomeElevation()}
            disabled={elHoming}
            className={elHoming ? 'homing-active' : ''}
            title="Drive elevation down until the end stop cuts current, then zero the encoder"
          >
            <Home size={14} />
            {elHoming ? 'Homing elevation…' : 'Home Elevation'}
          </button>
          <button
            onClick={() => void zeroAzimuth()}
            title="Zero the azimuth encoder at the current pointing position"
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
        ['PWM', value(motor?.pwm)],
        ['Encoder', encoder(motor?.encoder)],
        ['Speed', qpps(motor?.speed_qpps)],
      ]} />
    </div>
  );
}

// ─── Live tuning ──────────────────────────────────────────────────────────────

function LiveTuning({ runCommand }: { runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void> }) {
  const [m1Accel, setM1Accel] = useState(25_000);
  const [m2Accel, setM2Accel] = useState(25_000);
  const [bothDuty, setBothDuty] = useState(0);

  const applyAccel = async (e: FormEvent) => {
    e.preventDefault();
    await runCommand('set_m1_default_duty_accel', { accel: m1Accel });
    await runCommand('set_m2_default_duty_accel', { accel: m2Accel });
  };

  const applyDuty = async (e: FormEvent) => {
    e.preventDefault();
    await runCommand('duty_m1m2', { m1_duty: bothDuty, m2_duty: bothDuty });
  };

  return (
    <>
      <PanelHeader icon={<Sliders size={14} />} title="Live Tuning" />
      <form className="compact-form" onSubmit={applyAccel}>
        <label><span>M1 accel</span><input type="number" min={0} max={4_294_967_295} value={m1Accel} onChange={(e) => setM1Accel(Number(e.target.value))} /></label>
        <label><span>M2 accel</span><input type="number" min={0} max={4_294_967_295} value={m2Accel} onChange={(e) => setM2Accel(Number(e.target.value))} /></label>
        <button type="submit"><Save size={14} /> Apply</button>
      </form>
      <form className="compact-form" onSubmit={applyDuty}>
        <label><span>Duty trim</span><input type="number" min={-32767} max={32767} value={bothDuty} onChange={(e) => setBothDuty(Number(e.target.value))} /></label>
        <button type="submit"><Save size={14} /> Apply Duty</button>
        <button type="button" onClick={() => void runCommand('reset_encoders', {})}><RotateCcw size={14} /> Reset Enc</button>
      </form>
    </>
  );
}

// ─── Telemetry dashboard ─────────────────────────────────────────────────────

function TelemetryDashboard({ telemetry }: { telemetry: RoboClawTelemetry | null }) {
  return (
    <>
      <PanelHeader icon={<Activity size={14} />} title="Telemetry" />
      <div className="telemetry-dense">
        <DenseReadout title="Power" icon={<Zap size={11} />} rows={[
          ['Main',   volts(telemetry?.main_battery_v),   voltClass(telemetry?.main_battery_v)],
          ['Logic',  volts(telemetry?.logic_battery_v),  voltClass(telemetry?.logic_battery_v)],
          ['Status', telemetry?.status == null ? '—' : `0x${telemetry.status.toString(16).toUpperCase()}`],
        ]} />
        <DenseReadout title="Thermal" icon={<Thermometer size={11} />} rows={[
          ['T1',    celsius(telemetry?.temperature_c),   tempClass(telemetry?.temperature_c)],
          ['T2',    celsius(telemetry?.temperature_2_c), tempClass(telemetry?.temperature_2_c)],
          ['Flags', telemetry?.status_flags.length ? telemetry.status_flags.join(', ') : 'None'],
        ]} />
        <DenseReadout title="Pi" icon={<Cpu size={11} />} rows={[
          ['CPU temp', celsius(telemetry?.host.cpu_temp_c), tempClass(telemetry?.host.cpu_temp_c)],
          ['Load',     load(telemetry)],
          ['Memory',   percent(telemetry?.host.memory_used_percent)],
          ['Disk',     disk(telemetry)],
          ['Uptime',   duration(telemetry?.host.uptime_s)],
        ]} />
        <DenseReadout title="M1 Detail" rows={[
          ['Avg spd',  qpps(telemetry?.motors.m1?.average_speed_qpps)],
          ['Raw spd',  qpps(telemetry?.motors.m1?.raw_speed_qpps)],
          ['Spd err',  qpps(telemetry?.motors.m1?.speed_error_qpps)],
          ['Pos err',  value(telemetry?.motors.m1?.position_error)],
          ['Buf',      value(telemetry?.buffer_depths['1'])],
        ]} />
        <DenseReadout title="M2 Detail" rows={[
          ['Avg spd',  qpps(telemetry?.motors.m2?.average_speed_qpps)],
          ['Raw spd',  qpps(telemetry?.motors.m2?.raw_speed_qpps)],
          ['Spd err',  qpps(telemetry?.motors.m2?.speed_error_qpps)],
          ['Pos err',  value(telemetry?.motors.m2?.position_error)],
          ['Buf',      value(telemetry?.buffer_depths['2'])],
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

// ─── Terminal ────────────────────────────────────────────────────────────────

function HostTerminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 12,
      rows: 12,
      cols: 96,
      theme: {
        background: '#0a0e12',
        foreground: '#d3dbe3',
        cursor: '#72e0ad',
        selectionBackground: 'rgba(114, 224, 173, 0.2)',
      },
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal`);

    if (containerRef.current) {
      term.open(containerRef.current);
      term.focus();
    }

    ws.onopen = () => term.writeln('\x1b[32mConnected to host terminal.\x1b[0m');
    ws.onmessage = (event) => term.write(String(event.data));
    ws.onclose = () => term.writeln('\r\n\x1b[33m[terminal disconnected]\x1b[0m');
    ws.onerror = () => term.writeln('\r\n\x1b[31m[terminal websocket error]\x1b[0m');

    const disposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    return () => { disposable.dispose(); ws.close(); term.dispose(); };
  }, []);

  return (
    <>
      <PanelHeader icon={<TerminalIcon size={14} />} title="Terminal" />
      <div className="terminal-box" ref={containerRef} />
    </>
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
      title: 'RoboClaw serial link is unstable.',
      summary: hasSerialTimeout && hasCrcMismatch
        ? 'Reads are timing out and later bytes are corrupting CRC checks.'
        : hasSerialTimeout
          ? 'The controller is returning fewer bytes than expected before timeout.'
          : 'The controller returned bytes, but the packet checksum did not match.',
      action: 'Check baud rate, packet address, USB/TTL wiring, shared ground, and power noise. If wiring is solid, raise roboclaw.timeout_s to 2.0 and restart the service.',
    };
  }

  if (lower.includes('missing ack')) {
    return {
      title: 'RoboClaw did not acknowledge a command.',
      summary: 'A write command was sent, but the controller did not return the expected ACK byte.',
      action: 'Confirm Packet Serial mode, address 0x80-0x87, and that no other process is using the serial port.',
    };
  }

  return {
    title: 'RoboClaw reported an error.',
    summary: 'The latest telemetry snapshot included a controller read or command failure.',
    action: 'Open Recent errors below for the raw command message and timestamp.',
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
