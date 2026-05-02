import type { CommandInfo, CommandResult, RoboClawTelemetry } from './types';

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
  stop: () => request<Record<string, CommandResult>>('POST', '/api/roboclaw/stop'),
};
