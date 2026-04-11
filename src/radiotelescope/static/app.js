(function () {
    "use strict";

    // --- State ---
    const state = { connected: false, ws: null, reconnectTimer: null };

    // --- DOM cache ---
    const el = {
        connLed:      document.getElementById("conn-led"),
        uptime:       document.getElementById("uptime"),
        voltage:      document.getElementById("voltage"),
        shuntMv:      document.getElementById("shunt-mv"),
        current:      document.getElementById("current"),
        power:        document.getElementById("power"),
        safetyBadge:  document.getElementById("safety-badge"),
        lastTrip:     document.getElementById("last-trip"),
        eventLog:     document.getElementById("event-log"),
    };

    const axes = ["azimuth", "elevation"];
    const motor = {};
    axes.forEach(function (a) {
        motor[a] = {
            duty:      document.getElementById(a + "-duty"),
            direction: document.getElementById(a + "-direction"),
            tag:       document.getElementById(a + "-tag"),
            slider:    document.getElementById("speed-" + a),
            sliderVal: document.getElementById("speed-" + a + "-val"),
        };
    });

    // --- Helpers ---
    function formatUptime(s) {
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = Math.floor(s % 60);
        return (
            String(h).padStart(2, "0") + ":" +
            String(m).padStart(2, "0") + ":" +
            String(sec).padStart(2, "0")
        );
    }

    function logEvent(msg) {
        var ts = new Date().toLocaleTimeString();
        var line = "[" + ts + "] " + msg + "\n";
        el.eventLog.textContent = line + el.eventLog.textContent;
        // Cap at ~200 lines
        var lines = el.eventLog.textContent.split("\n");
        if (lines.length > 200) {
            el.eventLog.textContent = lines.slice(0, 200).join("\n");
        }
    }

    // --- API ---
    function apiCall(method, path, body) {
        var opts = { method: method, headers: { "Content-Type": "application/json" } };
        if (body != null) opts.body = JSON.stringify(body);
        return fetch("/api" + path, opts)
            .then(function (resp) {
                return resp.json().then(function (data) {
                    if (!resp.ok) throw new Error(data.detail || resp.statusText);
                    logEvent(method + " " + path + " -> OK");
                    return data;
                });
            })
            .catch(function (err) {
                logEvent(method + " " + path + " -> ERROR: " + err.message);
            });
    }

    // --- Motor commands (exposed globally for inline onclick) ---
    window.moveAxis = function (axis, direction) {
        var speed = parseInt(motor[axis].slider.value, 10);
        apiCall("POST", "/move", { axis: axis, speed: speed, direction: direction });
    };

    window.stopAxis = function (axis) {
        apiCall("POST", "/stop", { axis: axis });
    };

    function stopAll() {
        apiCall("POST", "/stop", { axis: null });
    }

    function resetSafety() {
        apiCall("POST", "/safety/reset");
    }

    // --- UI update (called on each WS message) ---
    function updateUI(ts) {
        // Motors
        axes.forEach(function (a) {
            var m = ts.motors[a];
            if (!m) return;
            motor[a].duty.textContent = m.duty;
            motor[a].direction.textContent = m.direction;
            if (m.is_moving) {
                motor[a].tag.textContent = "MOVING";
                motor[a].tag.classList.add("moving");
            } else {
                motor[a].tag.textContent = "IDLE";
                motor[a].tag.classList.remove("moving");
            }
        });

        // Sensor
        if (ts.sensor) {
            if (ts.sensor.available) {
                el.voltage.textContent = ts.sensor.bus_voltage_v.toFixed(2);
                el.shuntMv.textContent = ts.sensor.shunt_voltage_mv.toFixed(2);
                el.current.textContent = ts.sensor.current_a.toFixed(3);
                el.power.textContent = ts.sensor.power_w.toFixed(2);
            } else {
                el.voltage.textContent = "--";
                el.shuntMv.textContent = "--";
                el.current.textContent = "--";
                el.power.textContent = "--";
            }
        }

        // Safety
        if (ts.safety) {
            if (ts.safety.overcurrent_tripped) {
                el.safetyBadge.textContent = "TRIPPED";
                el.safetyBadge.className = "safety-badge tripped";
            } else if (ts.sensor && !ts.sensor.available) {
                el.safetyBadge.textContent = "DEGRADED";
                el.safetyBadge.className = "safety-badge tripped";
            } else {
                el.safetyBadge.textContent = "OK";
                el.safetyBadge.className = "safety-badge ok";
            }
            if (ts.safety.last_trip_timestamp) {
                el.lastTrip.textContent = new Date(ts.safety.last_trip_timestamp * 1000).toLocaleTimeString();
            } else {
                el.lastTrip.textContent = "never";
            }
        }

        // Uptime
        if (ts.uptime_s != null) {
            el.uptime.textContent = formatUptime(ts.uptime_s);
        }
    }

    // --- WebSocket ---
    function connectTelemetry() {
        var protocol = location.protocol === "https:" ? "wss:" : "ws:";
        var ws = new WebSocket(protocol + "//" + location.host + "/ws/telemetry");

        ws.onopen = function () {
            state.connected = true;
            el.connLed.classList.add("connected");
            el.connLed.title = "WebSocket connected";
            logEvent("WebSocket connected");
        };

        ws.onclose = function () {
            state.connected = false;
            el.connLed.classList.remove("connected");
            el.connLed.title = "WebSocket disconnected";
            logEvent("WebSocket disconnected — reconnecting in 2s");
            state.reconnectTimer = setTimeout(connectTelemetry, 2000);
        };

        ws.onerror = function () {
            logEvent("WebSocket error");
        };

        ws.onmessage = function (evt) {
            try {
                var data = JSON.parse(evt.data);
                updateUI(data);
            } catch (e) {
                logEvent("Bad WS message: " + e.message);
            }
        };

        state.ws = ws;
    }

    /*
     * TODO: Spectrum WebSocket (future)
     *
     * Connect to /ws/spectrum, decode base64 float32 magnitudes,
     * render on a <canvas> waterfall or line chart.
     *
     * Requires new API endpoints:
     *   POST /api/sdr/start  - start spectrum streaming
     *   POST /api/sdr/stop   - stop spectrum streaming
     *   POST /api/sdr/tune   - tune frequency / gain / sample rate
     *   GET  /api/sdr/status - current SDR config & streaming state
     *
     * Future UI data streams:
     *   /ws/events - server-side log streaming (safety trips, errors)
     *
     * Future UI features:
     *   - Canvas-based spectrum waterfall (decode base64 float32 FFT)
     *   - Position history time-series chart
     *   - SDR tuning controls (frequency, gain, sample rate)
     *   - Configuration editor panel
     */

    // --- Init ---
    function init() {
        // Slider live readout
        axes.forEach(function (a) {
            motor[a].slider.addEventListener("input", function () {
                motor[a].sliderVal.textContent = motor[a].slider.value;
            });
        });

        // Buttons
        document.getElementById("stop-all").addEventListener("click", stopAll);
        document.getElementById("btn-safety-reset").addEventListener("click", resetSafety);

        // Keyboard shortcuts
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                e.preventDefault();
                stopAll();
            }
        });

        connectTelemetry();
        logEvent("UI initialized");
    }

    document.addEventListener("DOMContentLoaded", init);
})();
