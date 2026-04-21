"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
const SLEW_SPEED = 40;           // % duty for arrow buttons
const HI_FREQ_HZ = 1_420_405_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const SESSION_KEY = "rt_session_token";
const WS_BACKOFF_MAX_MS = 16_000;

// ─── Utility ──────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

function decodeSpectrum(b64) {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = "") {
  const div = document.createElement("div");
  div.className = `toast ${type}`;
  div.textContent = msg;
  el("toast-container").appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Session-Token"] = token;
  const resp = await fetch(path, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.detail || resp.statusText), { status: resp.status });
  return data;
}

// ─── Session Manager ──────────────────────────────────────────────────────────
class SessionManager {
  constructor() {
    this.token = sessionStorage.getItem(SESSION_KEY) || null;
    this._heartbeatTimer = null;
    this._badgeEl = el("session-badge");
    this._statusEl = el("status-session");
  }

  get hasToken() { return this.token !== null; }

  async init() {
    try {
      const s = await api("GET", "/api/session/status");
      if (s.active && this.token) {
        // Our token might match — we can't verify server-side without a dedicated endpoint,
        // so just try a heartbeat; if 403, release locally.
        this._setInControl();
        this._startHeartbeat();
      } else if (s.active && !this.token) {
        this._setOtherControl();
      } else {
        this.token = null;
        sessionStorage.removeItem(SESSION_KEY);
        this._setNone();
      }
    } catch {
      this._setNone();
    }
  }

  async claim() {
    try {
      const data = await api("POST", "/api/session/claim", { client_id: navigator.userAgent.slice(0, 64) });
      this.token = data.token;
      sessionStorage.setItem(SESSION_KEY, this.token);
      this._setInControl();
      this._startHeartbeat();
      toast("Control acquired", "success");
      return true;
    } catch (err) {
      if (err.status === 409) {
        toast("Another user is in control", "error");
        this._setOtherControl();
      } else {
        toast("Could not claim session: " + err.message, "error");
      }
      return false;
    }
  }

  async ensureSession() {
    if (this.hasToken) return true;
    return this.claim();
  }

  sendHeartbeat(ws) {
    if (ws && ws.readyState === WebSocket.OPEN && this.token) {
      ws.send(JSON.stringify({ type: "heartbeat", token: this.token }));
    }
  }

  _startHeartbeat(wsGetter) {
    clearInterval(this._heartbeatTimer);
    // Heartbeat is sent by TelemetryWS each interval; nothing needed here except tracking.
  }

  _setInControl() {
    this._badgeEl.textContent = "In Control";
    this._badgeEl.className = "session-badge in-control";
    this._statusEl.textContent = "Session: in control";
  }

  _setOtherControl() {
    this._badgeEl.textContent = "Controlled by another";
    this._badgeEl.className = "session-badge other-control";
    this._statusEl.textContent = "Session: another user";
  }

  _setNone() {
    this._badgeEl.textContent = "Not in control";
    this._badgeEl.className = "session-badge";
    this._statusEl.textContent = "Session: none";
  }
}

// ─── Spectrum Canvas ──────────────────────────────────────────────────────────
class SpectrumCanvas {
  constructor(canvasEl) {
    this._canvas = canvasEl;
    this._ctx = canvasEl.getContext("2d");
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvasEl.parentElement);
    this._resize();
    this._lastFrame = null;
  }

  _resize() {
    const wrap = this._canvas.parentElement;
    this._canvas.width = wrap.clientWidth;
    this._canvas.height = wrap.clientHeight;
    if (this._lastFrame) this.draw(this._lastFrame);
  }

  draw(frame) {
    this._lastFrame = frame;
    const instant = decodeSpectrum(frame.magnitudes_b64);
    const rolling = decodeSpectrum(frame.rolling_b64);
    const ctx = this._ctx;
    const W = this._canvas.width;
    const H = this._canvas.height;
    const PAD = { top: 16, right: 10, bottom: 28, left: 46 };
    const PW = W - PAD.left - PAD.right;
    const PH = H - PAD.top - PAD.bottom;

    ctx.clearRect(0, 0, W, H);

    // Y range from rolling average (primary view)
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < rolling.length; i++) {
      if (rolling[i] < yMin) yMin = rolling[i];
      if (rolling[i] > yMax) yMax = rolling[i];
    }
    if (!isFinite(yMin) || yMin === yMax) { yMin = -80; yMax = -20; }
    const yPad = (yMax - yMin) * 0.08;
    yMin -= yPad; yMax += yPad;

    const xScale = i => PAD.left + (i / (rolling.length - 1)) * PW;
    const yScale = v => PAD.top + PH - ((v - yMin) / (yMax - yMin)) * PH;

    // Grid
    ctx.strokeStyle = "#2a2a40";
    ctx.lineWidth = 1;
    const ySteps = 5;
    for (let s = 0; s <= ySteps; s++) {
      const v = yMin + (yMax - yMin) * (s / ySteps);
      const y = yScale(v);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + PW, y);
      ctx.stroke();
      ctx.fillStyle = "#555570";
      ctx.font = "10px Consolas, monospace";
      ctx.textAlign = "right";
      ctx.fillText(v.toFixed(0) + " dB", PAD.left - 4, y + 3);
    }

    // Freq axis labels
    const bw = frame.bandwidth_hz;
    const freqLabels = [-1e6, -0.5e6, 0, 0.5e6, 1e6];
    ctx.textAlign = "center";
    freqLabels.forEach(offset => {
      const frac = (offset + bw / 2) / bw;
      if (frac < 0 || frac > 1) return;
      const x = PAD.left + frac * PW;
      ctx.fillStyle = "#555570";
      ctx.fillText(((HI_FREQ_HZ + offset) / 1e6).toFixed(2) + " MHz", x, H - 6);
      ctx.strokeStyle = "#2a2a40";
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + PH); ctx.stroke();
    });

    // H I centre line
    const centreX = PAD.left + PW / 2;
    ctx.save();
    ctx.strokeStyle = "#4455aa";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centreX, PAD.top);
    ctx.lineTo(centreX, PAD.top + PH);
    ctx.stroke();
    ctx.restore();

    // Instant trace (green, semi-transparent)
    ctx.strokeStyle = "rgba(0, 232, 122, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < instant.length; i++) {
      const x = xScale(i), y = yScale(instant[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Rolling trace (blue, full opacity)
    ctx.strokeStyle = "#4488ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < rolling.length; i++) {
      const x = xScale(i), y = yScale(rolling[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ─── Telemetry WebSocket ──────────────────────────────────────────────────────
class TelemetryWS {
  constructor(session) {
    this._session = session;
    this._ws = null;
    this._backoff = 1000;
    this._heartbeatTimer = null;
    this._dotEl = el("ws-dot");
    this._statusEl = el("status-ws");
    this.connect();
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this._ws = new WebSocket(`${proto}//${location.host}/ws/telemetry`);

    this._ws.onopen = () => {
      this._backoff = 1000;
      this._dotEl.className = "ws-dot connected";
      this._dotEl.title = "WebSocket connected";
      this._statusEl.textContent = "WebSocket: connected";
      this._startHeartbeat();
    };

    this._ws.onclose = () => {
      this._dotEl.className = "ws-dot reconnecting";
      this._dotEl.title = "WebSocket reconnecting";
      this._statusEl.textContent = `WebSocket: reconnecting in ${(this._backoff/1000).toFixed(0)}s`;
      this._stopHeartbeat();
      setTimeout(() => this.connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, WS_BACKOFF_MAX_MS);
    };

    this._ws.onerror = () => {};

    this._ws.onmessage = (evt) => {
      try {
        this._handleTelemetry(JSON.parse(evt.data));
      } catch {}
    };
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._session.sendHeartbeat(this._ws);
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
  }

  _handleTelemetry(ts) {
    // Motors
    ["azimuth", "elevation"].forEach(axis => {
      const m = ts.motors?.[axis];
      if (!m) return;
      const badge = el(`motor-${axis}`);
      if (m.is_moving) {
        badge.textContent = `${m.direction} ${m.duty}%`;
        badge.className = "motor-state-badge moving";
      } else {
        badge.textContent = "stopped";
        badge.className = "motor-state-badge";
      }
    });

    // Sensor
    const sen = ts.sensor;
    if (sen) {
      if (sen.available) {
        el("telem-voltage").textContent = sen.bus_voltage_v.toFixed(2);
        el("telem-current").textContent = sen.current_a.toFixed(3);
        el("telem-power").textContent = sen.power_w.toFixed(2);
      } else {
        el("telem-voltage").textContent = "--";
        el("telem-current").textContent = "--";
        el("telem-power").textContent = "--";
      }
    }

    // Safety
    const saf = ts.safety;
    const badge = el("safety-badge");
    if (saf?.overcurrent_tripped) {
      badge.textContent = "OVERCURRENT TRIP";
      badge.className = "safety-badge tripped";
    } else if (sen && !sen.available) {
      badge.textContent = "DEGRADED";
      badge.className = "safety-badge degraded";
    } else {
      badge.textContent = "OK";
      badge.className = "safety-badge";
    }

    // Uptime
    if (ts.uptime_s != null) {
      el("telem-uptime").textContent = formatUptime(ts.uptime_s);
    }
  }
}

// ─── Spectrum WebSocket ───────────────────────────────────────────────────────
class SpectrumWS {
  constructor(specCanvas) {
    this._canvas = specCanvas;
    this._ws = null;
    this._backoff = 1000;
    this._frameStatusEl = el("status-frame");
    this._placeholder = el("spectrum-placeholder");
    this._intElapsed = el("int-elapsed");
    this._intFrames = el("int-frames");
    this._intFill = el("int-fill");
    this._intWindow = el("int-window");
    this._active = false;
    this.connect();
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this._ws = new WebSocket(`${proto}//${location.host}/ws/spectrum`);

    this._ws.onopen = () => { this._backoff = 1000; };

    this._ws.onclose = () => {
      this._frameStatusEl.textContent = "Spectrum: disconnected";
      setTimeout(() => this.connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, WS_BACKOFF_MAX_MS);
    };

    this._ws.onerror = () => {};

    this._ws.onmessage = (evt) => {
      try {
        const frame = JSON.parse(evt.data);
        this._handleFrame(frame);
      } catch {}
    };
  }

  _handleFrame(frame) {
    // Hide placeholder once we get real data
    if (!this._active) {
      this._active = true;
      this._placeholder.classList.add("hidden");
    }

    this._canvas.draw(frame);

    // Integration progress
    const windowS = parseFloat(el("sel-int-window").value);
    const elapsed = Math.min(frame.integration_s ?? 0, windowS);
    this._intElapsed.textContent = elapsed.toFixed(1);
    this._intWindow.textContent = windowS;
    this._intFrames.textContent = frame.frame_count ?? 0;
    this._intFill.style.width = `${(elapsed / windowS) * 100}%`;

    const age = ((Date.now() / 1000) - frame.timestamp).toFixed(1);
    this._frameStatusEl.textContent = `Last frame: ${age}s ago`;
  }
}

// ─── Motion Controller ────────────────────────────────────────────────────────
class MotionController {
  constructor(session) {
    this._session = session;
    this._active = new Set(); // axes currently slewing
    this._setupButtons();
    this._setupStopAll();
  }

  _setupButtons() {
    document.querySelectorAll(".btn-arrow").forEach(btn => {
      const axis = btn.dataset.axis;
      const dir = btn.dataset.dir;

      const start = async (e) => {
        e.preventDefault();
        if (this._active.has(axis)) return;
        const ok = await this._session.ensureSession();
        if (!ok) return;
        btn.classList.add("pressed");
        this._active.add(axis);
        try {
          await api("POST", "/api/move", { axis, speed: SLEW_SPEED, direction: dir }, this._session.token);
        } catch (err) {
          this._active.delete(axis);
          btn.classList.remove("pressed");
          if (err.status === 403) { this._session.token = null; sessionStorage.removeItem(SESSION_KEY); }
          toast(err.message, "error");
        }
      };

      const stop = async (e) => {
        e.preventDefault();
        if (!this._active.has(axis)) return;
        btn.classList.remove("pressed");
        this._active.delete(axis);
        try {
          await api("POST", "/api/stop", { axis }, this._session.token);
        } catch {}
      };

      btn.addEventListener("pointerdown", start);
      btn.addEventListener("pointerup", stop);
      btn.addEventListener("pointerleave", stop);
      btn.addEventListener("contextmenu", e => e.preventDefault());
    });
  }

  _setupStopAll() {
    el("btn-stop-all").addEventListener("click", () => this._stopAll());
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); this._stopAll(); }
    });
  }

  async _stopAll() {
    try {
      await api("POST", "/api/stop", {}, this._session.token);
    } catch {}
    this._active.clear();
    document.querySelectorAll(".btn-arrow").forEach(b => b.classList.remove("pressed"));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const session = new SessionManager();
  await session.init();

  const specCanvas = new SpectrumCanvas(el("spectrum-canvas"));
  new TelemetryWS(session);
  new SpectrumWS(specCanvas);
  new MotionController(session);

  // SDR start/stop
  el("btn-sdr-start").addEventListener("click", async () => {
    const ok = await session.ensureSession();
    if (!ok) return;
    try {
      await api("POST", "/api/sdr/start", {}, session.token);
      toast("SDR started", "success");
    } catch (err) {
      toast("SDR start failed: " + err.message, "error");
    }
  });

  el("btn-sdr-stop").addEventListener("click", async () => {
    if (!session.hasToken) return;
    try {
      await api("POST", "/api/sdr/stop", {}, session.token);
      toast("SDR stopped");
    } catch (err) {
      toast("SDR stop failed: " + err.message, "error");
    }
  });

  // Safety reset
  el("btn-safety-reset").addEventListener("click", async () => {
    const ok = await session.ensureSession();
    if (!ok) return;
    try {
      await api("POST", "/api/safety/reset", {}, session.token);
      toast("Safety reset", "success");
    } catch (err) {
      toast("Safety reset failed: " + err.message, "error");
    }
  });

  // Integration reset
  el("btn-reset-int").addEventListener("click", async () => {
    if (!session.hasToken) return;
    const windowS = parseFloat(el("sel-int-window").value);
    try {
      await api("POST", "/api/sdr/integration", { window_s: windowS }, session.token);
    } catch (err) {
      toast("Reset failed: " + err.message, "error");
    }
  });

  // Integration window selector
  el("sel-int-window").addEventListener("change", async () => {
    if (!session.hasToken) return;
    const windowS = parseFloat(el("sel-int-window").value);
    el("int-window").textContent = String(windowS);
    try {
      await api("POST", "/api/sdr/integration", { window_s: windowS }, session.token);
    } catch (err) {
      toast("Failed to set window: " + err.message, "error");
    }
  });

  // Session badge click — take control
  el("session-badge").addEventListener("click", async () => {
    if (!session.hasToken) await session.claim();
  });
}

document.addEventListener("DOMContentLoaded", main);
