import { useEffect, useState } from 'react';

import type { SpectrumStatus } from './spectrumTypes';

// Polls /api/spectrum/status, auto-recovers a stalled SDR, and exposes the
// integration-restart action. Kept out of SpectrumPanel so the component body
// is just the render pipeline.
export function useSpectrumStatus(enabled: boolean) {
  const [status, setStatus] = useState<SpectrumStatus | null>(null);
  const [integrationRestarting, setIntegrationRestarting] = useState(false);
  const [integrationRestartError, setIntegrationRestartError] = useState<string | null>(null);

  const restartIntegration = async () => {
    if (integrationRestarting) return;
    setIntegrationRestarting(true);
    setIntegrationRestartError(null);
    try {
      const r = await fetch('/api/spectrum/reset', { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    } catch {
      setIntegrationRestartError('Integration restart failed. Try again in a moment.');
    } finally {
      setIntegrationRestarting(false);
    }
  };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch('/api/spectrum/status');
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const s = await r.json() as SpectrumStatus;
        if (cancelled) return;
        setStatus(s);
      } catch {
        if (cancelled) return;
        setStatus({ enabled: false, mode: 'unavailable' });
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [enabled]);

  // Auto-recover the SDR when frames stop flowing. We avoid hammering the
  // reconnect endpoint unconditionally — tearing down and re-opening the
  // dongle while it's healthy would actually *interrupt* the stream. Only
  // fire when the receiver is in a non-streaming state or no frame has
  // arrived in the last ~6 s, and throttle to one attempt every 5 s.
  // The endpoint requires control; for spectators the 403 is harmless.
  useEffect(() => {
    if (!status || !status.enabled) return;
    const SDR_HEALTHY_MODES = new Set(['airspy', 'remote']);
    const ageStale = status.latest_frame_age_s != null && status.latest_frame_age_s > 6;
    const modeStale = !SDR_HEALTHY_MODES.has(status.mode);
    if (!ageStale && !modeStale) return;

    let cancelled = false;
    let inFlight = false;
    const attempt = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await fetch('/api/spectrum/reconnect', { method: 'POST' });
      } catch { /* network blip — next tick retries */ }
      finally { inFlight = false; }
    };
    void attempt();
    const id = window.setInterval(attempt, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [status?.enabled, status?.mode, (status?.latest_frame_age_s ?? 0) > 6]);

  return { status, restartIntegration, integrationRestarting, integrationRestartError };
}
