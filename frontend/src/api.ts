import type { CommandInfo, CommandResult, RaDecTarget, RoboClawTelemetry, TelescopeConfig } from './types';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : resp.statusText;
    throw new ApiError(resp.status, detail);
  }
  return data as T;
}

export const api = {
  status: () => request<RoboClawTelemetry>('GET', '/api/roboclaw/status'),
  commands: () => request<CommandInfo[]>('GET', '/api/roboclaw/commands'),
  execute: (commandId: string, args: Record<string, number | boolean>) =>
    request<CommandResult>('POST', `/api/roboclaw/commands/${commandId}`, { args }),
  gotoAltAz: (altitudeDeg: number, azimuthDeg: number, speedQpps?: number, accelQpps2?: number) =>
    request<CommandResult>('POST', '/api/telescope/goto', {
      altitude_deg: altitudeDeg,
      azimuth_deg: azimuthDeg,
      speed_qpps: speedQpps,
      accel_qpps2: accelQpps2,
      decel_qpps2: accelQpps2,
    }),
  telescopeConfig: () => request<TelescopeConfig>('GET', '/api/telescope/config'),
  gotoRaDec: (target: RaDecTarget, speedQpps?: number, accelQpps2?: number) =>
    request<CommandResult>('POST', '/api/telescope/goto_radec', {
      ra_deg: target.ra_deg,
      dec_deg: target.dec_deg,
      speed_qpps: speedQpps,
      accel_qpps2: accelQpps2,
      decel_qpps2: accelQpps2,
    }),
  syncAltAz: (altitudeDeg: number, azimuthDeg: number) =>
    request<Record<string, CommandResult>>('POST', '/api/telescope/sync', {
      altitude_deg: altitudeDeg,
      azimuth_deg: azimuthDeg,
    }),
  stop: () => request<Record<string, CommandResult>>('POST', '/api/roboclaw/stop'),
  homeElevation: () => request<{ status: string; message: string }>('POST', '/api/telescope/home/elevation'),
  zeroAzimuth:   () => request<{ status: string; message: string }>('POST', '/api/telescope/home/azimuth'),
  zeroAltitude:  () => request<{ status: string; message: string }>('POST', '/api/telescope/home/altitude'),
};
