import './styles/main.css';

import { createApi } from './api';
import { $ } from './lib/dom';
import { SessionManager } from './session';
import { Toaster } from './toast';
import { ConfigureView } from './ui/configure';
import { ControlView } from './ui/control';
import { Header } from './ui/header';
import { ObserveView } from './ui/observe';
import { Sidebar, type ViewId } from './ui/sidebar';
import { StatusBar } from './ui/status-bar';
import { SpectrumWs } from './ws/spectrum';
import { TelemetryWs } from './ws/telemetry';

async function bootstrap(): Promise<void> {
  const root = $('#app');

  // ── Core services ──────────────────────────────────────────────────────────
  // api<>session have a chicken-and-egg: api.getToken needs the session, session
  // needs the api. Indirect via a holder so the circular reference resolves cleanly.
  const sessionHolder: { current: SessionManager | null } = { current: null };
  const api = createApi({ getToken: () => sessionHolder.current?.token ?? null });
  const session = new SessionManager(api);
  sessionHolder.current = session;

  const toaster = new Toaster();
  session.on('notification', ({ kind, message }) => toaster.show(message, kind));
  await session.init();

  // ── Views ──────────────────────────────────────────────────────────────────
  const observe = new ObserveView(api, session, toaster);
  const control = new ControlView(api, session, toaster);
  const configure = new ConfigureView(api, session, toaster);

  const views: Record<ViewId, { show(): void; hide(): void; element: HTMLElement }> = {
    observe, control, configure,
  };

  // Hide non-default views so the initial layout measures correctly.
  control.hide();
  configure.hide();

  let activeId: ViewId = 'observe';
  const switchView = (id: ViewId): void => {
    if (id === activeId) return;
    views[activeId].hide();
    views[id].show();
    activeId = id;
  };

  const statusBar = new StatusBar();
  const stopAll = (): Promise<void> => control.stopAll();
  const header = new Header(session, stopAll);
  const sidebar = new Sidebar(switchView);

  // ── WebSocket feeds ────────────────────────────────────────────────────────
  const telemetryWs = new TelemetryWs(session);
  const spectrumWs = new SpectrumWs();

  telemetryWs.on('status', (status) => {
    header.setWsStatus(status);
    statusBar.setWs(status);
  });
  telemetryWs.on('telemetry', (ts) => {
    header.applyTelemetry(ts.sensor, ts.safety);
    observe.onTelemetry(ts);
    control.onTelemetry(ts);
  });

  spectrumWs.on('frame', (frame) => {
    observe.onFrame(frame);
    statusBar.setFrameAge(Date.now() / 1000 - frame.timestamp);
  });
  spectrumWs.on('disconnected', () => statusBar.setFrameAge(null));

  session.on('change', (s) => {
    const label = s.kind === 'in-control' ? 'in control'
      : s.kind === 'other-control' ? 'other user' : 'none';
    statusBar.setSession(label);
  });

  // ── DOM assembly ───────────────────────────────────────────────────────────
  const mainEl = document.createElement('main');
  mainEl.className = 'app-main';
  mainEl.appendChild(observe.element);
  mainEl.appendChild(control.element);
  mainEl.appendChild(configure.element);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'app-body';
  bodyEl.appendChild(sidebar.element);
  bodyEl.appendChild(mainEl);

  root.appendChild(header.element);
  root.appendChild(bodyEl);
  root.appendChild(statusBar.element);
  root.appendChild(toaster.element);

  // ── Start feeds and global keybinds ────────────────────────────────────────
  telemetryWs.start();
  spectrumWs.start();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      void stopAll();
    }
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start UI:', err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = '<div style="padding:2rem;font-family:system-ui;color:#eee">' +
      'Fatal error initialising UI — see console.</div>';
  }
});
