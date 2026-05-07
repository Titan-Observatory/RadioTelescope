export interface QueueStatus {
  token: string;
  is_active: boolean;
  position: number;
  queue_length: number;
  lease_remaining_s: number | null;
  idle_remaining_s: number | null;
  has_active_user: boolean;
}

export interface QueueConfig {
  enabled: boolean;
  turnstile_enabled: boolean;
  turnstile_site_key: string;
  max_session_seconds: number;
  idle_timeout_seconds: number;
}

export async function fetchQueueConfig(): Promise<QueueConfig> {
  const r = await fetch('/api/queue/config');
  if (!r.ok) throw new Error(`queue config: ${r.status}`);
  return r.json();
}

export async function fetchQueueStatus(): Promise<QueueStatus> {
  const r = await fetch('/api/queue/status');
  if (!r.ok) throw new Error(`queue status: ${r.status}`);
  return r.json();
}

export async function joinQueue(turnstileToken: string | null): Promise<QueueStatus> {
  const r = await fetch('/api/queue/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstile_token: turnstileToken }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `join: ${r.status}`);
  return data as QueueStatus;
}

export async function leaveQueue(): Promise<void> {
  await fetch('/api/queue/leave', { method: 'POST' });
}
