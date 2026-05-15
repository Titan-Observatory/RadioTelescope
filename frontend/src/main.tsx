import './styles/main.css';

import {
  Activity, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Cpu, Crosshair, HelpCircle, Home, Info, LogOut, Monitor, Navigation, X, Zap,
} from 'lucide-react';
import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api, ApiError } from './api';
import { BRAND } from './branding';
import { SkyMap } from './components/SkyMap';
import { SpectrumPanel } from './components/SpectrumPanel';
import { QueuePage } from './components/QueuePage';
import { startTour, maybePromptFirstVisit } from './tour';
import { startGuidedObservation } from './guidedObservation';
import {
  fetchQueueConfig, fetchQueueStatus, joinQueue, leaveQueue,
  type QueueConfig, type QueueStatus,
} from './queue';
import type { CommandInfo, RoboClawTelemetry, TelescopeConfig } from './types';

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
  const [hasMapTarget, setHasMapTarget] = useState(false);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [queueConfig, setQueueConfig] = useState<QueueConfig | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [tooltipsEnabled, setTooltipsEnabled] = useState(true);
  const nextErrorId = useRef(1);
  const prevIsActiveRef = useRef<boolean | null>(null);
  const lastLeaseRemainingRef = useRef<number | null>(null);

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

  // Track the last known lease time so we can distinguish lease expiry from
  // idle timeout when the session drops.
  useEffect(() => {
    if (queueStatus?.lease_remaining_s != null) {
      lastLeaseRemainingRef.current = queueStatus.lease_remaining_s;
    }
  }, [queueStatus?.lease_remaining_s]);

  // Auto-refresh only on hard lease expiry with an empty queue. An idle
  // timeout leaves plenty of lease time remaining, so lastLeaseRemainingRef
  // will still be high — correctly skipping the reload in that case.
  useEffect(() => {
    const wasActive = prevIsActiveRef.current;
    prevIsActiveRef.current = queueStatus?.is_active ?? null;
    if (
      wasActive === true &&
      queueStatus?.is_active === false &&
      queueStatus.queue_length === 0 &&
      lastLeaseRemainingRef.current != null &&
      lastLeaseRemainingRef.current < 15
    ) {
      window.location.reload();
    }
  }, [queueStatus?.is_active, queueStatus?.queue_length]);

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

  const gotoAltAz = async (altDeg: number, azDeg: number) => {
    setNotice(null);
    try {
      await api.gotoAltAz(altDeg, azDeg);
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const gotoRaDec = useCallback(async (raDeg: number, decDeg: number) => {
    setNotice(null);
    try {
      await api.gotoRaDec({ ra_deg: raDeg, dec_deg: decDeg });
      setTelemetry(await api.status());
    } catch (err) {
      setNotice(errorMessage(err));
    }
  }, []);

  const launchGuidedObservation = useCallback(() => {
    startGuidedObservation(gotoRaDec);
  }, [gotoRaDec]);

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
    setHasMapTarget(true);
  }, []);

  const controllerIssue = explainControllerError(telemetry?.last_error ?? null);

  // Queue gating: when the queue is enabled and we are not the active
  // controller, render the spectator/queue page instead of the control UI.
  // Position 0 = active controller; -1 = not in queue; >0 = waiting.
  const queueEnabled = queueConfig?.enabled ?? false;
  const isActiveController = !queueEnabled || queueStatus?.is_active === true;

  // Offer the first-visit guided tour once the user actually has the controls
  // in front of them — no point prompting while they're still on the queue page.
  useEffect(() => {
    if (!isActiveController) return;
    const t = setTimeout(() => maybePromptFirstVisit(launchGuidedObservation), 600);
    return () => clearTimeout(t);
  }, [isActiveController, launchGuidedObservation]);

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
        tooltipsEnabled={tooltipsEnabled}
        onToggleTooltips={() => setTooltipsEnabled((enabled) => !enabled)}
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
        <section className="panel skymap-panel">
          <SkyMap
            telemetry={telemetry}
            config={telescopeConfig}
            onNotice={setNotice}
            onTarget={handleMapTarget}
            tooltipsEnabled={tooltipsEnabled}
          />
          <div className="skymap-bottom-dock">
            <div className="skymap-overlay-controls">
              <MotionControls
                runCommand={runCommand}
                gotoAltAz={gotoAltAz}
                targetAz={targetAz}
                targetAlt={targetAlt}
                setTargetAz={setTargetAz}
                setTargetAlt={setTargetAlt}
              />
            </div>
            {hasMapTarget && (
              <button
                type="button"
                className="skymap-slew-target"
                onClick={() => void gotoAltAz(targetAlt, targetAz)}
                title={`Slew to Az ${targetAz.toFixed(3)} deg, Alt ${targetAlt.toFixed(3)} deg`}
              >
                <Navigation size={24} />
                <span>Slew</span>
              </button>
            )}
          </div>
        </section>
        <div className="dashboard-rightcol">
          <section className="panel spectrum-panel-host">
            <SpectrumPanel onStartGuided={launchGuidedObservation} />
          </section>
          <section className="panel status-side-panel">
            <TelemetryDashboard telemetry={telemetry} />
          </section>
        </div>
        <section className="panel controls-panel">
          <AdminPanel syncAltAz={syncAltAz} homeElevation={homeElevation} zeroAzimuth={zeroAzimuth} zeroAltitude={zeroAltitude} targetAz={targetAz} targetAlt={targetAlt} />
        </section>
      </main>
      <MobileHint />
    </div>
  );
}

// ─── Mobile hint ─────────────────────────────────────────────────────────────

const MOBILE_HINT_KEY = 'rt-mobile-hint-dismissed';

function MobileHint() {
  const [visible, setVisible] = useState(() =>
    typeof window !== 'undefined' &&
    window.innerWidth <= 640 &&
    !localStorage.getItem(MOBILE_HINT_KEY),
  );

  if (!visible) return null;

  const dismiss = () => {
    localStorage.setItem(MOBILE_HINT_KEY, '1');
    setVisible(false);
  };

  return (
    <div className="mobile-hint" role="dialog" aria-label="Desktop recommendation">
      <Monitor size={16} className="mobile-hint-icon" aria-hidden="true" />
      <p className="mobile-hint-text">
        For the best experience, open this page on a desktop browser.
      </p>
      <button type="button" className="mobile-hint-close" onClick={dismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
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

function TopBar({
  telemetry,
  leaseStatus,
  onLeaveLease,
  tooltipsEnabled,
  onToggleTooltips,
}: {
  telemetry: RoboClawTelemetry | null;
  leaseStatus: QueueStatus | null;
  onLeaveLease: () => void;
  tooltipsEnabled: boolean;
  onToggleTooltips: () => void;
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
        <button
          type="button"
          className={`topbar-tooltips${tooltipsEnabled ? ' active' : ''}`}
          onClick={onToggleTooltips}
          title={tooltipsEnabled ? 'Hide hover tooltips' : 'Show hover tooltips'}
          aria-pressed={tooltipsEnabled}
        >
          <Info size={14} /> Tooltips
        </button>
        <button
          type="button"
          className="topbar-help"
          onClick={() => startTour()}
          title="Take a guided tour of the controls"
        >
          <HelpCircle size={14} /> Tour
        </button>
        <span className="topbar-time" title="Time at the telescope (EST)">
          <span className="topbar-time-label">Telescope time</span>
          {telemetry
            ? `${new Date(telemetry.timestamp * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })} EST`
            : '—'}
        </span>
      </div>
    </header>
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

// Combined floating control surface. A sliding segmented toggle picks between
// the press-and-hold jog pad and the numeric GoTo form so a single overlay
// holds both interaction modes without doubling the on-screen real estate.
function MotionControls({
  runCommand, gotoAltAz, targetAz, targetAlt, setTargetAz, setTargetAlt,
}: {
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
  gotoAltAz: (alt: number, az: number) => Promise<void>;
  targetAz: number;
  targetAlt: number;
  setTargetAz: (v: number) => void;
  setTargetAlt: (v: number) => void;
}) {
  const [mode, setMode] = useState<'jog' | 'goto'>('jog');
  const [slewSpeed, setSlewSpeed] = useState(40);
  const speed = Math.round(slewSpeed * 127 / 100);

  const submitTarget = async (e: FormEvent) => {
    e.preventDefault();
    await gotoAltAz(targetAlt, targetAz);
  };

  return (
    <>
      <div className="motion-controls-title">
        Motion
      </div>
      <div className="motion-mode" role="radiogroup" aria-label="Control mode">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'jog'}
          className="motion-mode-step"
          onClick={() => setMode('jog')}
        >
          Jog
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'goto'}
          className="motion-mode-step"
          onClick={() => setMode('goto')}
        >
          GoTo
        </button>
      </div>
      {mode === 'jog' ? (
        <div className="motion-card">
          <PointingPad runCommand={runCommand} speed={speed} />
          <SpeedFader slewSpeed={slewSpeed} setSlewSpeed={setSlewSpeed} />
        </div>
      ) : (
        <form className="target-form target-form-overlay" onSubmit={submitTarget}>
          <label>
            <span>Azimuth °</span>
            <input
              type="number" min={0} max={360} step={0.001}
              value={targetAz}
              onChange={(e) => setTargetAz(Number(e.target.value))}
            />
          </label>
          <label>
            <span>Altitude °</span>
            <input
              type="number" min={0} max={90} step={0.001}
              value={targetAlt}
              onChange={(e) => setTargetAlt(Number(e.target.value))}
            />
          </label>
          <button type="submit" className="action-button">
            <Navigation size={14} /> Slew
          </button>
        </form>
      )}
    </>
  );
}

const SPEED_PRESETS: { id: 'fine' | 'coarse' | 'slew'; label: string; value: number }[] = [
  { id: 'fine',   label: 'Fine',   value: 10 },
  { id: 'coarse', label: 'Coarse', value: 40 },
  { id: 'slew',   label: 'Slew',   value: 85 },
];

function SpeedFader({ slewSpeed, setSlewSpeed }: {
  slewSpeed: number;
  setSlewSpeed: (n: number) => void;
}) {
  const active = SPEED_PRESETS.reduce((best, p) =>
    Math.abs(p.value - slewSpeed) < Math.abs(best.value - slewSpeed) ? p : best,
  SPEED_PRESETS[0]);

  return (
    <div className="speed-toggle" role="radiogroup" aria-label="Slew speed">
      <span className="speed-toggle-heading">Speed</span>
      {SPEED_PRESETS.map((p) => {
        const selected = p.id === active.id;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`speed-toggle-btn speed-toggle-${p.id}${selected ? ' is-active' : ''}`}
            onClick={() => setSlewSpeed(p.value)}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// Admin panel
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
    <details className="admin-panel" data-tour="calibration">
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

// ─── Pointing pad + axis status ───────────────────────────────────────────────

// RoboClaw's firmware serial-timeout failsafe stops the motors if no command
// arrives within ~1 s. Re-issuing the drive command at this cadence is safely
// inside that window while still being light on the bus.
const JOG_REPEAT_MS = 200;

function PointingPad({ runCommand, speed }: {
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
  speed: number;
}) {
  const west = useJog(() => runCommand('backward_m1', { speed }), () => runCommand('backward_m1', { speed: 0 }));
  const east = useJog(() => runCommand('forward_m1',  { speed }), () => runCommand('forward_m1',  { speed: 0 }));
  const down = useJog(() => runCommand('backward_m2', { speed }), () => runCommand('backward_m2', { speed: 0 }));
  const up   = useJog(() => runCommand('forward_m2',  { speed }), () => runCommand('forward_m2',  { speed: 0 }));

  return (
    <div className="pointing-pad" role="group" aria-label="Pointing controls">
      <button type="button" className={`pad-btn pad-up${up.active ? ' jog-active' : ''}`} {...up} aria-label="Up">
        <ChevronUp size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">Up</span>
      </button>
      <button type="button" className={`pad-btn pad-west${west.active ? ' jog-active' : ''}`} {...west} aria-label="West">
        <ChevronLeft size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">West</span>
      </button>
      <button type="button" className={`pad-btn pad-east${east.active ? ' jog-active' : ''}`} {...east} aria-label="East">
        <ChevronRight size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">East</span>
      </button>
      <button type="button" className={`pad-btn pad-down${down.active ? ' jog-active' : ''}`} {...down} aria-label="Down">
        <ChevronDown size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">Down</span>
      </button>
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
  const systemPower = minReading(telemetry?.main_battery_v, telemetry?.logic_battery_v);
  const roboclawTemp = maxReading(telemetry?.temperature_c, telemetry?.temperature_2_c);
  const motorOutput = maxAbsReading(telemetry?.motors.m1?.pwm, telemetry?.motors.m2?.pwm);
  const motorSpeed = maxAbsReading(telemetry?.motors.m1?.speed_qpps, telemetry?.motors.m2?.speed_qpps);

  return (
    <>
      <div className="telemetry-dense">
        <DenseReadout title="System" icon={<Activity size={11} />} rows={[
          ['Connection', telemetry?.connection?.connected === false ? 'Issue' : 'Stable', telemetry?.connection?.connected === false ? 'val-crit' : 'val-ok'],
          ['Power', volts(systemPower), voltClass(systemPower)],
          ['RoboClaw temp', celsius(roboclawTemp), tempClass(roboclawTemp)],
          ['Pi temp', celsius(telemetry?.host.cpu_temp_c), tempClass(telemetry?.host.cpu_temp_c)],
        ]} />
        <DenseReadout title="Pointing" icon={<Navigation size={11} />} rows={[
          ['Azimuth', telemetry?.azimuth_deg == null ? '—' : `${telemetry.azimuth_deg.toFixed(2)}°`],
          ['Elevation', telemetry?.altitude_deg == null ? '—' : `${telemetry.altitude_deg.toFixed(2)}°`],
        ]} />
        <DenseReadout title="Drive" icon={<Zap size={11} />} rows={[
          ['State', motorState(motorSpeed, motorOutput)],
          ['Azimuth amps', amps(telemetry?.motors.m1?.current_a)],
          ['Elevation amps', amps(telemetry?.motors.m2?.current_a)],
          ['Azimuth encoder', encoder(telemetry?.motors.m1?.encoder)],
          ['Elevation encoder', encoder(telemetry?.motors.m2?.encoder)],
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

function volts(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(2)} V`;
}

function celsius(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(1)} °C`;
}

function amps(input: number | null | undefined): string {
  return input == null ? '—' : `${Math.abs(input).toFixed(2)} A`;
}

function encoder(input: number | null | undefined): string {
  return input == null ? '—' : input.toLocaleString();
}

function minReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length === 0 ? null : Math.min(...present);
}

function maxReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length === 0 ? null : Math.max(...present);
}

function maxAbsReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null).map(Math.abs);
  return present.length === 0 ? null : Math.max(...present);
}

function motorState(speed: number | null, output: number | null): string {
  if (speed == null && output == null) return '—';
  return (speed ?? 0) > 0 || (output ?? 0) > 0 ? 'Moving' : 'Idle';
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
