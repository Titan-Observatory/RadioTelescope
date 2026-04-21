"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
const HI_FREQ_HZ = 1_420_405_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const SESSION_KEY = "rt_session_token";
const WS_BACKOFF_MAX_MS = 16_000;
const SDR_POLL_MS = 5_000;

// ─── Utilities ────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function decodeSpectrum(b64) {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

function setBusy(btn, busy) {
  btn.disabled = busy;
  btn.classList.toggle("loading", busy);
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
  const resp = await fetch(path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.detail || resp.statusText), { status: resp.status });
  return data;
}

// ─── Tab Controller ───────────────────────────────────────────────────────────
class TabController {
  constructor(onTabChange) {
    this._onTabChange = onTabChange;
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => this._activate(btn.dataset.tab));
    });
  }

  _activate(tabId) {
    document.querySelectorAll(".tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tabId));
    document.querySelectorAll(".tab-panel").forEach(p =>
      p.classList.toggle("hidden", p.id !== `tab-${tabId}`));
    this._onTabChange(tabId);
  }
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
      const data = await api("POST", "/api/session/claim", {
        client_id: navigator.userAgent.slice(0, 64),
      });
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

  async release() {
    if (!this.token) return;
    try {
      await api("POST", "/api/session/release", {}, this.token);
    } catch {}
    this.token = null;
    sessionStorage.removeItem(SESSION_KEY);
    clearInterval(this._heartbeatTimer);
    this._setNone();
    toast("Control released");
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

  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    // Heartbeat messages are sent by TelemetryWS on each interval tick.
  }

  _setInControl() {
    this._badgeEl.textContent = "In Control";
    this._badgeEl.title = "Click to release control";
    this._badgeEl.className = "session-badge in-control";
    this._statusEl.textContent = "Session: in control";
  }

  _setOtherControl() {
    this._badgeEl.textContent = "Controlled by another";
    this._badgeEl.title = "Another user has control";
    this._badgeEl.className = "session-badge other-control";
    this._statusEl.textContent = "Session: another user";
  }

  _setNone() {
    this._badgeEl.textContent = "Not in control";
    this._badgeEl.title = "Click to take control";
    this._badgeEl.className = "session-badge";
    this._statusEl.textContent = "Session: none";
  }
}

// ─── Config Manager ───────────────────────────────────────────────────────────
class ConfigManager {
  constructor(session) {
    this._session = session;
  }

  async load() {
    try {
      const cfg = await api("GET", "/api/config");
      this._populate(cfg);
    } catch (err) {
      toast("Failed to load config: " + err.message, "error");
    }
  }

  _populate(cfg) {
    const { sdr, safety, motors } = cfg;
    // SDR
    el("cfg-sdr-freq").value = (sdr.center_freq_hz / 1e6).toFixed(3);
    el("cfg-sdr-gain").value = sdr.gain;
    el("cfg-sdr-rate").value = sdr.sample_rate_hz;
    el("cfg-sdr-fft").value = sdr.fft_size;
    el("cfg-sdr-int-count").value = sdr.integration_count;
    // Safety
    el("cfg-overcurrent-threshold").value = safety.overcurrent_threshold_a;
    el("cfg-overcurrent-holdoff").value = safety.overcurrent_holdoff_s;
    el("cfg-az-min").value = safety.azimuth_min_deg;
    el("cfg-az-max").value = safety.azimuth_max_deg;
    el("cfg-el-min").value = safety.elevation_min_deg;
    el("cfg-el-max").value = safety.elevation_max_deg;
    // Motors
    el("cfg-az-max-duty").value = motors.azimuth.max_duty;
    el("cfg-az-ramp").value = motors.azimuth.ramp_time_s;
    el("cfg-el-max-duty").value = motors.elevation.max_duty;
    el("cfg-el-ramp").value = motors.elevation.ramp_time_s;
  }

  async applySdr(btn) {
    const ok = await this._session.ensureSession();
    if (!ok) return;
    const gainRaw = el("cfg-sdr-gain").value.trim();
    const gain = gainRaw === "" || gainRaw.toLowerCase() === "auto"
      ? "auto"
      : parseFloat(gainRaw);
    const body = {
      center_freq_hz: Math.round(parseFloat(el("cfg-sdr-freq").value) * 1e6),
      sample_rate_hz: parseInt(el("cfg-sdr-rate").value, 10),
      gain,
      fft_size: parseInt(el("cfg-sdr-fft").value, 10),
      integration_count: parseInt(el("cfg-sdr-int-count").value, 10),
    };
    setBusy(btn, true);
    try {
      const result = await api("PATCH", "/api/config/sdr", body, this._session.token);
      const note = result.needs_restart ? " — restart SDR for FFT/integration changes" : "";
      toast("SDR settings applied" + note, "success");
    } catch (err) {
      toast("SDR settings failed: " + err.message, "error");
    } finally {
      setBusy(btn, false);
    }
  }

  async applySafety(btn) {
    const ok = await this._session.ensureSession();
    if (!ok) return;
    const body = {
      overcurrent_threshold_a: parseFloat(el("cfg-overcurrent-threshold").value),
      overcurrent_holdoff_s: parseFloat(el("cfg-overcurrent-holdoff").value),
      azimuth_min_deg: parseFloat(el("cfg-az-min").value),
      azimuth_max_deg: parseFloat(el("cfg-az-max").value),
      elevation_min_deg: parseFloat(el("cfg-el-min").value),
      elevation_max_deg: parseFloat(el("cfg-el-max").value),
    };
    setBusy(btn, true);
    try {
      await api("PATCH", "/api/config/safety", body, this._session.token);
      toast("Safety settings applied", "success");
    } catch (err) {
      toast("Safety settings failed: " + err.message, "error");
    } finally {
      setBusy(btn, false);
    }
  }

  async applyMotors(btn) {
    const ok = await this._session.ensureSession();
    if (!ok) return;
    setBusy(btn, true);
    try {
      await Promise.all([
        api("PATCH", "/api/config/motor/azimuth", {
          max_duty: parseInt(el("cfg-az-max-duty").value, 10),
          ramp_time_s: parseFloat(el("cfg-az-ramp").value),
        }, this._session.token),
        api("PATCH", "/api/config/motor/elevation", {
          max_duty: parseInt(el("cfg-el-max-duty").value, 10),
          ramp_time_s: parseFloat(el("cfg-el-ramp").value),
        }, this._session.token),
      ]);
      toast("Motor settings applied", "success");
    } catch (err) {
      toast("Motor settings failed: " + err.message, "error");
    } finally {
      setBusy(btn, false);
    }
  }
}

// ─── SDR Status ───────────────────────────────────────────────────────────────
class SdrStatus {
  constructor() {
    this._pollTimer = null;
  }

  startPolling() {
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), SDR_POLL_MS);
  }

  async refresh() {
    await this._poll();
  }

  async _poll() {
    try {
      const s = await api("GET", "/api/sdr/status");
      this._apply(s);
    } catch {}
  }

  _apply(s) {
    const running = s.running ?? false;
    const badge = el("sdr-status-badge");
    badge.textContent = running ? "Running" : "Stopped";
    badge.className = `sdr-status-badge ${running ? "running" : "stopped"}`;
    if (s.center_freq_hz != null)
      el("sdr-freq-display").textContent = (s.center_freq_hz / 1e6).toFixed(3) + " MHz";
    if (s.sample_rate_hz != null)
      el("sdr-rate-display").textContent = (s.sample_rate_hz / 1e6).toFixed(3) + " MS/s";
    if (s.gain != null)
      el("sdr-gain-display").textContent = s.gain === "auto" ? "auto" : s.gain + " dB";
    if (s.fft_size != null)
      el("sdr-fft-display").textContent = s.fft_size;
    el("btn-sdr-start").disabled = running;
    el("btn-sdr-stop").disabled = !running;
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

    // Grid lines + Y labels
    ctx.strokeStyle = "#2a2a40";
    ctx.lineWidth = 1;
    for (let s = 0; s <= 5; s++) {
      const v = yMin + (yMax - yMin) * (s / 5);
      const y = yScale(v);
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + PW, y); ctx.stroke();
      ctx.fillStyle = "#555570";
      ctx.font = "10px Consolas, monospace";
      ctx.textAlign = "right";
      ctx.fillText(v.toFixed(0) + " dB", PAD.left - 4, y + 3);
    }

    // Freq axis labels
    const bw = frame.bandwidth_hz;
    ctx.textAlign = "center";
    [-1e6, -0.5e6, 0, 0.5e6, 1e6].forEach(offset => {
      const frac = (offset + bw / 2) / bw;
      if (frac < 0 || frac > 1) return;
      const x = PAD.left + frac * PW;
      ctx.fillStyle = "#555570";
      ctx.fillText(((HI_FREQ_HZ + offset) / 1e6).toFixed(2) + " MHz", x, H - 6);
      ctx.strokeStyle = "#2a2a40";
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + PH); ctx.stroke();
    });

    // H I centre line
    ctx.save();
    ctx.strokeStyle = "#4455aa";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left + PW / 2, PAD.top);
    ctx.lineTo(PAD.left + PW / 2, PAD.top + PH);
    ctx.stroke();
    ctx.restore();

    // Instant trace
    ctx.strokeStyle = "rgba(0, 232, 122, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < instant.length; i++) {
      const x = xScale(i), y = yScale(instant[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Rolling average trace
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
      this._statusEl.textContent = `WebSocket: reconnecting in ${(this._backoff / 1000).toFixed(0)}s`;
      this._stopHeartbeat();
      setTimeout(() => this.connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, WS_BACKOFF_MAX_MS);
    };

    this._ws.onerror = () => {};

    this._ws.onmessage = evt => {
      try { this._handleTelemetry(JSON.parse(evt.data)); } catch {}
    };
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._session.sendHeartbeat(this._ws);
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() { clearInterval(this._heartbeatTimer); }

  _handleTelemetry(ts) {
    // Motor state badges
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

    // Power sensor
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

    // Safety state — update both the telemetry strip badge and the header pill
    const saf = ts.safety;
    const tripped = saf?.overcurrent_tripped;
    const degraded = sen && !sen.available;

    const stripBadge = el("safety-badge");
    const headerPill = el("safety-pill");
    if (tripped) {
      stripBadge.textContent = "OVERCURRENT TRIP";
      stripBadge.className = "safety-badge tripped";
      headerPill.textContent = "\u25CF TRIPPED";
      headerPill.className = "safety-pill tripped";
    } else if (degraded) {
      stripBadge.textContent = "DEGRADED";
      stripBadge.className = "safety-badge degraded";
      headerPill.textContent = "\u25CF DEGRADED";
      headerPill.className = "safety-pill degraded";
    } else {
      stripBadge.textContent = "OK";
      stripBadge.className = "safety-badge";
      headerPill.textContent = "\u25CF OK";
      headerPill.className = "safety-pill";
    }

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

    this._ws.onmessage = evt => {
      try { this._handleFrame(JSON.parse(evt.data)); } catch {}
    };
  }

  _handleFrame(frame) {
    if (!this._active) {
      this._active = true;
      this._placeholder.classList.add("hidden");
    }
    this._canvas.draw(frame);
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
    this._active = new Set();
    this._setupSpeedSlider();
    this._setupButtons();
    this._setupStopAll();
  }

  get _speed() {
    return parseInt(el("slew-speed").value, 10);
  }

  _setupSpeedSlider() {
    const slider = el("slew-speed");
    const display = el("slew-speed-val");
    slider.addEventListener("input", () => {
      display.textContent = slider.value + "%";
    });
  }

  _setupButtons() {
    document.querySelectorAll(".btn-arrow").forEach(btn => {
      const axis = btn.dataset.axis;
      const dir = btn.dataset.dir;

      const start = async e => {
        e.preventDefault();
        if (this._active.has(axis)) return;
        const ok = await this._session.ensureSession();
        if (!ok) return;
        btn.classList.add("pressed");
        this._active.add(axis);
        try {
          await api("POST", "/api/move",
            { axis, speed: this._speed, direction: dir },
            this._session.token);
        } catch (err) {
          this._active.delete(axis);
          btn.classList.remove("pressed");
          if (err.status === 403) {
            this._session.token = null;
            sessionStorage.removeItem(SESSION_KEY);
          }
          toast(err.message, "error");
        }
      };

      const stop = async e => {
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

  const config = new ConfigManager(session);
  const sdrStatus = new SdrStatus();
  const specCanvas = new SpectrumCanvas(el("spectrum-canvas"));

  new TelemetryWS(session);
  new SpectrumWS(specCanvas);
  new MotionController(session);

  // Load config into form fields and start SDR status polling
  config.load();
  sdrStatus.startPolling();

  // Tab switching with side effects
  new TabController(tabId => {
    if (tabId === "configure") config.load();
    if (tabId === "control") sdrStatus.refresh();
  });

  // Session badge — click to claim or release
  el("session-badge").addEventListener("click", async () => {
    if (session.hasToken) await session.release();
    else await session.claim();
  });

  // SDR start/stop
  el("btn-sdr-start").addEventListener("click", async () => {
    const ok = await session.ensureSession();
    if (!ok) return;
    const btn = el("btn-sdr-start");
    setBusy(btn, true);
    try {
      await api("POST", "/api/sdr/start", {}, session.token);
      toast("SDR started", "success");
      await sdrStatus.refresh();
    } catch (err) {
      toast("SDR start failed: " + err.message, "error");
    } finally {
      setBusy(btn, false);
    }
  });

  el("btn-sdr-stop").addEventListener("click", async () => {
    if (!session.hasToken) return;
    const btn = el("btn-sdr-stop");
    setBusy(btn, true);
    try {
      await api("POST", "/api/sdr/stop", {}, session.token);
      toast("SDR stopped");
      await sdrStatus.refresh();
    } catch (err) {
      toast("SDR stop failed: " + err.message, "error");
    } finally {
      setBusy(btn, false);
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

  // Integration window controls
  el("btn-reset-int").addEventListener("click", async () => {
    if (!session.hasToken) return;
    const windowS = parseFloat(el("sel-int-window").value);
    try {
      await api("POST", "/api/sdr/integration", { window_s: windowS }, session.token);
    } catch (err) {
      toast("Reset failed: " + err.message, "error");
    }
  });

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

  // Configure tab — apply buttons
  el("btn-apply-sdr").addEventListener("click", e => config.applySdr(e.currentTarget));
  el("btn-apply-safety").addEventListener("click", e => config.applySafety(e.currentTarget));
  el("btn-apply-motors").addEventListener("click", e => config.applyMotors(e.currentTarget));

  el("btn-reload-config").addEventListener("click", async e => {
    setBusy(e.currentTarget, true);
    await config.load();
    setBusy(e.currentTarget, false);
    toast("Config reloaded from server", "success");
  });
}

document.addEventListener("DOMContentLoaded", main);
