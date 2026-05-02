import './styles/main.css';
import '@xterm/xterm/css/xterm.css';

import { AlertTriangle, RotateCcw, Save, Square } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api, ApiError } from './api';
import type { CommandInfo, CommandResult, RoboClawTelemetry } from './types';

function App() {
  const [telemetry, setTelemetry] = useState<RoboClawTelemetry | null>(null);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [history, setHistory] = useState<CommandResult[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api.status().then(setTelemetry).catch((err) => setNotice(errorMessage(err)));
    void api.commands().then(setCommands).catch((err) => setNotice(errorMessage(err)));

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/roboclaw`);
    ws.onmessage = (event) => setTelemetry(JSON.parse(event.data) as RoboClawTelemetry);
    ws.onerror = () => setNotice('RoboClaw telemetry websocket disconnected.');
    return () => ws.close();
  }, []);

  const commandById = useMemo(() => Object.fromEntries(commands.map((command) => [command.id, command])), [commands]);

  const runCommand = async (commandId: string, args: Record<string, number | boolean>) => {
    const command = commandById[commandId];
    if (!command) {
      setNotice(`Command unavailable: ${commandId}`);
      return;
    }
    setNotice(null);
    try {
      const result = await api.execute(command.id, args);
      setHistory((items) => [result, ...items].slice(0, 6));
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const stopAll = async () => {
    setNotice(null);
    try {
      const result = await api.stop();
      setHistory((items) => [...Object.values(result), ...items].slice(0, 6));
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  return (
    <div className="app-shell">
      <TopBar telemetry={telemetry} stopAll={stopAll} />
      {telemetry?.connection.mode !== 'serial' && (
        <div className={`banner ${telemetry?.connection.mode === 'error' ? 'banner-error' : ''}`}>
          <AlertTriangle size={16} />
          <span>{telemetry?.connection.message ?? 'Using simulated RoboClaw data.'}</span>
        </div>
      )}
      {notice && <div className="banner banner-error"><AlertTriangle size={16} /><span>{notice}</span></div>}

      <main className="dashboard">
        <section className="panel controls-panel">
          <TelescopeControls telemetry={telemetry} runCommand={runCommand} stopAll={stopAll} />
        </section>
        <section className="panel tune-panel">
          <LiveTuning runCommand={runCommand} />
        </section>
        <section className="panel telemetry-panel">
          <TelemetryDashboard telemetry={telemetry} />
        </section>
        <section className="panel history-panel">
          <CommandHistory items={history} />
        </section>
        <section className="panel terminal-panel">
          <HostTerminal />
        </section>
      </main>
    </div>
  );
}

function TopBar({ telemetry, stopAll }: { telemetry: RoboClawTelemetry | null; stopAll: () => Promise<void> }) {
  const connection = telemetry?.connection;
  return (
    <header className="topbar compact">
      <div>
        <h1>RoboClaw Telescope Control</h1>
        <p>{connection ? `${connection.port} / ${connection.baudrate} baud / 0x${connection.address.toString(16)}` : 'Connecting...'}</p>
      </div>
      <div className="topbar-status">
        <span className={`mode mode-${connection?.mode ?? 'simulated'}`}>{connection?.mode ?? 'loading'}</span>
        <span>{telemetry ? new Date(telemetry.timestamp * 1000).toLocaleTimeString() : 'No telemetry'}</span>
        <button className="stop-button" onClick={() => void stopAll()} title="Stop both motors">
          <Square size={16} /> Stop
        </button>
      </div>
    </header>
  );
}

function TelescopeControls({ telemetry, runCommand, stopAll }: {
  telemetry: RoboClawTelemetry | null;
  runCommand: (commandId: string, args: Record<string, number | boolean>) => Promise<void>;
  stopAll: () => Promise<void>;
}) {
  const [slewSpeed, setSlewSpeed] = useState(40);
  const speed = Math.round(slewSpeed * 127 / 100);
  return (
    <div className="controls-grid">
      <AxisControl
        title="Azimuth"
        negativeLabel="West"
        positiveLabel="East"
        motor={telemetry?.motors.m1}
        negative={() => runCommand('backward_m1', { speed })}
        positive={() => runCommand('forward_m1', { speed })}
      />
      <AxisControl
        title="Elevation"
        negativeLabel="Down"
        positiveLabel="Up"
        motor={telemetry?.motors.m2}
        negative={() => runCommand('backward_m2', { speed })}
        positive={() => runCommand('forward_m2', { speed })}
      />
      <div className="speed-row">
        <label>
          <span>Slew</span>
          <strong>{slewSpeed}%</strong>
          <input type="range" min={1} max={100} value={slewSpeed} onChange={(e) => setSlewSpeed(Number(e.target.value))} />
        </label>
        <button className="stop-button" onClick={() => void stopAll()}><Square size={16} /> Stop All</button>
      </div>
    </div>
  );
}

function AxisControl({ title, negativeLabel, positiveLabel, motor, negative, positive }: {
  title: string;
  negativeLabel: string;
  positiveLabel: string;
  motor: RoboClawTelemetry['motors'][string] | undefined;
  negative: () => Promise<void>;
  positive: () => Promise<void>;
}) {
  return (
    <div className="axis-compact">
      <div className="axis-title">
        <h2>{title}</h2>
        <span>{motor?.current_a == null ? '-' : `${motor.current_a.toFixed(2)} A`}</span>
      </div>
      <div className="axis-actions">
        <button onClick={() => void negative()}>{negativeLabel}</button>
        <button onClick={() => void positive()}>{positiveLabel}</button>
      </div>
      <DenseReadout rows={[
        ['PWM', value(motor?.pwm)],
        ['Encoder', value(motor?.encoder)],
        ['Speed', qpps(motor?.speed_qpps)],
      ]} />
    </div>
  );
}

function LiveTuning({ runCommand }: { runCommand: (commandId: string, args: Record<string, number | boolean>) => Promise<void> }) {
  const [m1Accel, setM1Accel] = useState(25_000);
  const [m2Accel, setM2Accel] = useState(25_000);
  const [bothDuty, setBothDuty] = useState(0);

  const applyAcceleration = async (event: FormEvent) => {
    event.preventDefault();
    await runCommand('set_m1_default_duty_accel', { accel: m1Accel });
    await runCommand('set_m2_default_duty_accel', { accel: m2Accel });
  };

  const applyDutyTrim = async (event: FormEvent) => {
    event.preventDefault();
    await runCommand('duty_m1m2', { m1_duty: bothDuty, m2_duty: bothDuty });
  };

  return (
    <>
      <h2>Live Tuning</h2>
      <form className="compact-form" onSubmit={applyAcceleration}>
        <label><span>M1 accel</span><input type="number" min={0} max={4_294_967_295} value={m1Accel} onChange={(e) => setM1Accel(Number(e.target.value))} /></label>
        <label><span>M2 accel</span><input type="number" min={0} max={4_294_967_295} value={m2Accel} onChange={(e) => setM2Accel(Number(e.target.value))} /></label>
        <button type="submit"><Save size={15} /> Apply</button>
      </form>
      <form className="compact-form" onSubmit={applyDutyTrim}>
        <label><span>Duty trim</span><input type="number" min={-32767} max={32767} value={bothDuty} onChange={(e) => setBothDuty(Number(e.target.value))} /></label>
        <button type="submit"><Save size={15} /> Apply Duty</button>
        <button type="button" onClick={() => void runCommand('reset_encoders', {})}><RotateCcw size={15} /> Reset Encoders</button>
      </form>
    </>
  );
}

function TelemetryDashboard({ telemetry }: { telemetry: RoboClawTelemetry | null }) {
  return (
    <>
      <h2>Telemetry</h2>
      <div className="telemetry-dense">
        <DenseReadout title="Power" rows={[
          ['Main', volts(telemetry?.main_battery_v)],
          ['Logic', volts(telemetry?.logic_battery_v)],
          ['Status', telemetry?.status == null ? '-' : `0x${telemetry.status.toString(16)}`],
        ]} />
        <DenseReadout title="Thermal" rows={[
          ['T1', celsius(telemetry?.temperature_c)],
          ['T2', celsius(telemetry?.temperature_2_c)],
          ['Flags', telemetry?.status_flags.length ? telemetry.status_flags.join(', ') : 'None'],
        ]} />
        <DenseReadout title="Pi" rows={[
          ['CPU temp', celsius(telemetry?.host.cpu_temp_c)],
          ['Load', load(telemetry)],
          ['Memory', percent(telemetry?.host.memory_used_percent)],
          ['Disk', disk(telemetry)],
          ['Uptime', duration(telemetry?.host.uptime_s)],
        ]} />
        <DenseReadout title="M1 Detail" rows={[
          ['Avg', qpps(telemetry?.motors.m1?.average_speed_qpps)],
          ['Raw', qpps(telemetry?.motors.m1?.raw_speed_qpps)],
          ['Err', qpps(telemetry?.motors.m1?.speed_error_qpps)],
          ['Pos err', value(telemetry?.motors.m1?.position_error)],
        ]} />
        <DenseReadout title="M2 Detail" rows={[
          ['Avg', qpps(telemetry?.motors.m2?.average_speed_qpps)],
          ['Raw', qpps(telemetry?.motors.m2?.raw_speed_qpps)],
          ['Err', qpps(telemetry?.motors.m2?.speed_error_qpps)],
          ['Pos err', value(telemetry?.motors.m2?.position_error)],
        ]} />
      </div>
    </>
  );
}

function DenseReadout({ title, rows }: { title?: string; rows: [string, string][] }) {
  return (
    <div className="dense-readout">
      {title && <h3>{title}</h3>}
      <dl>
        {rows.map(([label, val]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{val}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

function CommandHistory({ items }: { items: CommandResult[] }) {
  return (
    <>
      <h2>Recent Commands</h2>
      {items.length === 0 ? <p className="muted">No commands yet.</p> : (
        <ol className="compact-history">
          {items.map((item, index) => (
            <li key={`${item.command_id}-${index}`}>
              <strong>{item.command_id}</strong>
              <span>{item.ok ? 'ok' : item.error ?? 'failed'}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function HostTerminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 12,
      rows: 12,
      cols: 96,
      theme: {
        background: '#0e1216',
        foreground: '#d3dbe3',
        cursor: '#72e0ad',
      },
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal`);

    if (containerRef.current) {
      term.open(containerRef.current);
      term.focus();
    }

    ws.onopen = () => term.writeln('Connected to host terminal.');
    ws.onmessage = (event) => term.write(String(event.data));
    ws.onclose = () => term.writeln('\r\n[terminal disconnected]');
    ws.onerror = () => term.writeln('\r\n[terminal websocket error]');

    const disposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    return () => {
      disposable.dispose();
      ws.close();
      term.dispose();
    };
  }, []);

  return (
    <>
      <h2>Terminal</h2>
      <div className="terminal-box" ref={containerRef} />
    </>
  );
}

function value(input: number | null | undefined): string {
  return input == null ? '-' : String(input);
}

function volts(input: number | null | undefined): string {
  return input == null ? '-' : `${input.toFixed(1)} V`;
}

function celsius(input: number | null | undefined): string {
  return input == null ? '-' : `${input.toFixed(1)} C`;
}

function qpps(input: number | null | undefined): string {
  return input == null ? '-' : `${input}`;
}

function percent(input: number | null | undefined): string {
  return input == null ? '-' : `${input.toFixed(1)}%`;
}

function load(telemetry: RoboClawTelemetry | null): string {
  const host = telemetry?.host;
  if (!host || host.load_1m == null) return '-';
  const cores = host.cpu_count ? ` / ${host.cpu_count}c` : '';
  return `${host.load_1m.toFixed(2)}${cores}`;
}

function disk(telemetry: RoboClawTelemetry | null): string {
  const host = telemetry?.host;
  if (!host || host.disk_used_percent == null || host.disk_free_gb == null) return '-';
  return `${host.disk_used_percent.toFixed(1)}% / ${host.disk_free_gb.toFixed(1)} GB free`;
}

function duration(input: number | null | undefined): string {
  if (input == null) return '-';
  const totalMinutes = Math.floor(input / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
