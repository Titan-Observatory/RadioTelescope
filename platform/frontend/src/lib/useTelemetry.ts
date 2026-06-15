// Owns the RoboClaw telemetry stream: the initial fetch, the websocket
// subscription, and the latest snapshot.

import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorMessage } from './formatters';
import { useJsonSocket } from './useJsonSocket';
import type { RoboClawTelemetry } from '../types';

export interface UseTelemetryOptions {
  onError: (source: string, message: string) => void;
  enabled?: boolean;
}

export interface UseTelemetryResult {
  telemetry: RoboClawTelemetry | null;
}

export function useTelemetry({ onError, enabled = true }: UseTelemetryOptions): UseTelemetryResult {
  const [telemetry, setTelemetry] = useState<RoboClawTelemetry | null>(null);

  useEffect(() => {
    if (!enabled) return;
    void api.status().then((next) => {
      setTelemetry(next);
      if (next.last_error) onError('RoboClaw', next.last_error);
    }).catch((err) => onError('API', errorMessage(err)));
  }, [enabled, onError]);

  useJsonSocket<RoboClawTelemetry>('/ws/roboclaw', {
    enabled,
    onMessage: (next) => {
      setTelemetry(next);
      if (next.last_error) onError('RoboClaw', next.last_error);
    },
    onError: () => onError('WebSocket', 'RoboClaw telemetry websocket disconnected.'),
  });

  return { telemetry };
}
