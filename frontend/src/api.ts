import type {
  AppConfigDump,
  Axis,
  MotorAxisConfig,
  MotorState,
  MoveCommand,
  SafetyConfig,
  SDRConfig,
  SDRStatus,
  SessionStatus,
  StopCommand,
  TelescopeState,
} from './types';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface ApiOptions {
  getToken: () => string | null;
}

export function createApi(opts: ApiOptions) {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    { auth = false }: { auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = opts.getToken();
      if (token) headers['X-Session-Token'] = token;
    }
    const resp = await fetch(path, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}) as Record<string, unknown>);
    if (!resp.ok) {
      const detail = (data as { detail?: string })?.detail ?? resp.statusText;
      throw new ApiError(resp.status, detail);
    }
    return data as T;
  }

  return {
    // Session
    sessionStatus: () => request<SessionStatus>('GET', '/api/session/status'),
    sessionClaim: (clientId: string) =>
      request<{ token: string }>('POST', '/api/session/claim', { client_id: clientId }),
    sessionRelease: () =>
      request<{ status: string }>('POST', '/api/session/release', undefined, { auth: true }),

    // System status
    status: () => request<TelescopeState>('GET', '/api/status'),
    health: () => request<{ status: string }>('GET', '/api/health'),
    safetyReset: () =>
      request<{ status: string }>('POST', '/api/safety/reset', undefined, { auth: true }),

    // Motion
    move: (cmd: MoveCommand) =>
      request<MotorState>('POST', '/api/move', cmd, { auth: true }),
    stop: (cmd: StopCommand = {}) =>
      request<Record<string, MotorState>>('POST', '/api/stop', cmd, { auth: true }),
    position: () => request<Record<string, MotorState>>('GET', '/api/position'),

    // SDR
    sdrStatus: () => request<SDRStatus>('GET', '/api/sdr/status'),
    sdrStart: () => request<{ status: string }>('POST', '/api/sdr/start', undefined, { auth: true }),
    sdrStop: () => request<{ status: string }>('POST', '/api/sdr/stop', undefined, { auth: true }),
    sdrSetIntegrationWindow: (windowS: number) =>
      request<{ window_s: number }>('POST', '/api/sdr/integration', { window_s: windowS }, { auth: true }),

    // Configuration
    getConfig: () => request<AppConfigDump>('GET', '/api/config'),
    patchSafety: (body: Partial<SafetyConfig>) =>
      request<SafetyConfig>('PATCH', '/api/config/safety', body, { auth: true }),
    patchSdr: (body: Partial<SDRConfig>) =>
      request<SDRConfig & { needs_restart: boolean }>('PATCH', '/api/config/sdr', body, { auth: true }),
    patchMotor: (axis: Axis, body: Partial<MotorAxisConfig>) =>
      request<MotorAxisConfig & { axis: Axis }>('PATCH', `/api/config/motor/${axis}`, body, { auth: true }),
  };
}

export type Api = ReturnType<typeof createApi>;
