// Which observation mode the hardware service booted in. Fetched once per
// session — the mode is a boot-time hardware choice (LNA swap + restart), so
// there is nothing to poll. On failure we retry a few times then fall back to
// hydrogen-line, matching the platform proxy's degraded behaviour.

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ObservationInfo } from '../types';

const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

export interface UseObservationModeResult {
  /** null while the first fetch is in flight. */
  info: ObservationInfo | null;
  isGoes: boolean;
}

export function useObservationMode(enabled = true): UseObservationModeResult {
  const [info, setInfo] = useState<ObservationInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchMode = async () => {
      try {
        const next = await api.observation();
        if (!cancelled) setInfo(next);
      } catch {
        if (cancelled) return;
        attempt += 1;
        if (attempt < MAX_RETRIES) {
          timer = setTimeout(fetchMode, RETRY_DELAY_MS);
        } else {
          setInfo({
            mode: 'hydrogen_line',
            downlink_freq_mhz: null,
            symbol_rate_baud: null,
            target_satellite_id: null,
            satellites: [],
            degraded: true,
          });
        }
      }
    };
    void fetchMode();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled]);

  return { info, isGoes: info?.mode === 'goes' };
}
