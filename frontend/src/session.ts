import type { Api } from './api';
import { ApiError } from './api';
import { Emitter } from './lib/emitter';

const STORAGE_KEY = 'rt_session_token';

export type SessionStateKind = 'none' | 'in-control' | 'other-control';

export interface SessionState {
  kind: SessionStateKind;
  token: string | null;
}

interface SessionEvents {
  change: SessionState;
  notification: { kind: 'info' | 'success' | 'error'; message: string };
}

export class SessionManager extends Emitter<SessionEvents> {
  private _token: string | null = null;
  private _kind: SessionStateKind = 'none';

  constructor(private readonly api: Api) {
    super();
    this._token = sessionStorage.getItem(STORAGE_KEY);
  }

  get token(): string | null { return this._token; }
  get kind(): SessionStateKind { return this._kind; }
  get hasToken(): boolean { return this._token !== null; }

  async init(): Promise<void> {
    try {
      const s = await this.api.sessionStatus();
      if (s.active && this._token) {
        this.setKind('in-control');
      } else if (s.active) {
        this.setKind('other-control');
      } else {
        this.clearToken();
        this.setKind('none');
      }
    } catch {
      this.setKind('none');
    }
  }

  async claim(): Promise<boolean> {
    try {
      const { token } = await this.api.sessionClaim(navigator.userAgent.slice(0, 64));
      this.setToken(token);
      this.setKind('in-control');
      this.emit('notification', { kind: 'success', message: 'Control acquired' });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.emit('notification', { kind: 'error', message: 'Another user is in control' });
        this.setKind('other-control');
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        this.emit('notification', { kind: 'error', message: `Could not claim session: ${msg}` });
      }
      return false;
    }
  }

  async release(): Promise<void> {
    if (!this._token) return;
    try {
      await this.api.sessionRelease();
    } catch { /* best-effort */ }
    this.clearToken();
    this.setKind('none');
    this.emit('notification', { kind: 'info', message: 'Control released' });
  }

  async ensure(): Promise<boolean> {
    return this.hasToken ? true : this.claim();
  }

  /** Clear token locally, e.g. after a 403 response. */
  revokeLocal(): void {
    this.clearToken();
    this.setKind('none');
  }

  /** Used by TelemetryWS to send periodic heartbeats. */
  heartbeatPayload(): string | null {
    return this._token ? JSON.stringify({ type: 'heartbeat', token: this._token }) : null;
  }

  private setToken(token: string): void {
    this._token = token;
    sessionStorage.setItem(STORAGE_KEY, token);
  }

  private clearToken(): void {
    this._token = null;
    sessionStorage.removeItem(STORAGE_KEY);
  }

  private setKind(kind: SessionStateKind): void {
    if (this._kind === kind) return;
    this._kind = kind;
    this.emit('change', { kind, token: this._token });
  }
}
