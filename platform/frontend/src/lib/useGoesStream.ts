// Owns the GOES downlink status stream: the /ws/goes subscription, a slow
// status poll for liveness, and the auto-reconnect nudge that respawns the
// demod pipeline when frames stop flowing (mirrors SpectrumPanel's SDR
// recovery loop). Lifted to a hook so the connect panel and the data
// explorer share one socket and one view of the acquisition state.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useJsonSocket } from './useJsonSocket';
import type { GoesFrame, GoesStatus } from '../types';

const STATUS_POLL_MS = 5000;
const RECONNECT_THROTTLE_MS = 6000;
const STALE_FRAME_S = 8;

export interface UseGoesStreamResult {
  frame: GoesFrame | null;
  status: GoesStatus | null;
  connected: boolean;
  /** Frame sync on the downlink achieved — the data explorer unlocks. */
  isLocked: boolean;
}

export function useGoesStream(enabled: boolean): UseGoesStreamResult {
  const [frame, setFrame] = useState<GoesFrame | null>(null);
  const [status, setStatus] = useState<GoesStatus | null>(null);

  const { connected } = useJsonSocket<GoesFrame>('/ws/goes', {
    enabled,
    onMessage: setFrame,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.goesStatus();
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus({ enabled: false, mode: 'unavailable' });
      }
    };
    void refresh();
    const id = window.setInterval(refresh, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [enabled]);

  // Auto-recover the pipeline when it faults or frames go stale. Throttled,
  // and a no-op for spectators (the reconnect endpoint requires control).
  const frameTimestamp = frame?.timestamp ?? null;
  useEffect(() => {
    if (!enabled || !status || !status.enabled) return;
    const modeBad = status.mode === 'fault' || status.mode === 'unavailable';
    const stale = frameTimestamp != null && Date.now() / 1000 - frameTimestamp > STALE_FRAME_S;
    if (!modeBad && !stale) return;

    let cancelled = false;
    let inFlight = false;
    const attempt = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await api.goesReconnect();
      } catch { /* spectator 403 or network blip — next tick retries */ }
      finally { inFlight = false; }
    };
    void attempt();
    const id = window.setInterval(attempt, RECONNECT_THROTTLE_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [enabled, status?.enabled, status?.mode, frameTimestamp != null && Date.now() / 1000 - frameTimestamp > STALE_FRAME_S]);

  const isLocked = useMemo(
    () => frame != null && (frame.stage === 'frames' || frame.stage === 'data'),
    [frame],
  );

  return { frame, status, connected, isLocked };
}
