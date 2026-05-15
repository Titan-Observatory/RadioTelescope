// Lightweight client-side event tracker. Mirrors the feedback endpoint:
// each call POSTs one JSON object that the server appends to events.jsonl.
//
// Schema (server-side row, see routes_events.py):
//   ts                    server-assigned UTC ISO8601
//   ts_client             browser-assigned UTC ISO8601 (for ordering within a session)
//   session_id            random per-tab id (sessionStorage)
//   event                 snake_case event name
//   is_active_controller  whether the user holds the queue lease
//   queue_position        0=active, >0=waiting, -1=not in queue, null=queue disabled
//   viewport_w/h          for "is this a phone-screen problem?" cuts
//   device_class          'desktop' | 'tablet' | 'mobile'
//   page_path             window.location.pathname
//   client_ip_hash        12-char sha256 prefix (set server-side)
//   props                 event-specific bag, capped at 4KB
//
// Keep top-level fields stable so DuckDB/pandas can project them as columns;
// put anything variable in `props`.

const SESSION_STORAGE_KEY = 'rt-analytics-session';

function getOrCreateSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return `nostore-${Date.now()}`;
  }
}

function deviceClass(): 'desktop' | 'tablet' | 'mobile' {
  const w = window.innerWidth;
  if (w < 600) return 'mobile';
  if (w < 1024) return 'tablet';
  return 'desktop';
}

interface Context {
  isActiveController: boolean | null;
  queuePosition: number | null;
}

const ctx: Context = { isActiveController: null, queuePosition: null };

export function setAnalyticsContext(next: Partial<Context>) {
  if (next.isActiveController !== undefined) ctx.isActiveController = next.isActiveController;
  if (next.queuePosition !== undefined) ctx.queuePosition = next.queuePosition;
}

export function track(event: string, props: Record<string, unknown> = {}) {
  const payload = {
    event,
    session_id: getOrCreateSessionId(),
    ts_client: new Date().toISOString(),
    is_active_controller: ctx.isActiveController,
    queue_position: ctx.queuePosition,
    viewport_w: window.innerWidth,
    viewport_h: window.innerHeight,
    device_class: deviceClass(),
    page_path: window.location.pathname,
    props,
  };

  const body = JSON.stringify(payload);

  // Prefer sendBeacon so events fire reliably even during page unload.
  // Beacon requires a Blob with the right MIME; falls back to fetch keepalive.
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/events', blob)) return;
    }
  } catch { /* fall through */ }

  void fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => { /* tracking must never throw at the call site */ });
}
