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

        // Sky map pointing update
        if (ts.position) {
            skyMap.updatePointing(ts.position);
        }

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

// =============================================================================
// Sky Map module — Aladin Lite v3 + HI4PI survey + potentiometer pointing overlay
// =============================================================================
var skyMap = (function () {
    "use strict";

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------
    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;

    // HI4PI: all-sky neutral hydrogen column density survey (21 cm / 1420 MHz).
    // Displayed as a false-colour intensity map — bright regions have more HI.
    var HI4PI_SURVEY = "CDS/P/HI4PI/NHI";
    // Pointing circle radius on the sky (degrees).  Adjust to match beam FWHM.
    var BEAM_DEG = 2.0;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    var aladin = null;
    var pointingOverlay = null;
    var observer = { latitude: 51.5, longitude: -0.1, elevation_m: 0.0 };
    var lastRaDec = null;  // {ra, dec} of last valid pointing, for Center button

    // DOM refs
    var elPointAz  = document.getElementById("point-az");
    var elPointEl  = document.getElementById("point-el");
    var elPointRa  = document.getElementById("point-ra");
    var elPointDec = document.getElementById("point-dec");
    var elCursorAz = document.getElementById("cursor-az");
    var elCursorEl = document.getElementById("cursor-el");

    // -------------------------------------------------------------------------
    // Coordinate math (no external library needed)
    // -------------------------------------------------------------------------

    // Julian Date from a JS Date
    function julianDate(date) {
        return date.valueOf() / 86400000.0 + 2440587.5;
    }

    // Greenwich Mean Sidereal Time in hours (IAU 1982)
    function gmstHours(date) {
        var JD = julianDate(date);
        var T  = (JD - 2451545.0) / 36525.0;
        var theta = 280.46061837
                  + 360.98564736629 * (JD - 2451545.0)
                  + 0.000387933 * T * T
                  - T * T * T / 38710000.0;
        return ((theta % 360) + 360) % 360 / 15.0;
    }

    // Local Sidereal Time in hours
    function lstHours(date, lon_deg) {
        return ((gmstHours(date) + lon_deg / 15.0) % 24 + 24) % 24;
    }

    // Az/El (degrees, Az 0=N 90=E) → {ra, dec} in degrees
    // Returns null if the conversion is geometrically undefined (e.g. at the pole)
    function horizToEquatorial(az_deg, alt_deg, lat_deg, date, lon_deg) {
        var az  = az_deg  * DEG;
        var alt = alt_deg * DEG;
        var lat = lat_deg * DEG;

        var sin_dec = Math.sin(alt) * Math.sin(lat)
                    + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
        sin_dec = Math.max(-1.0, Math.min(1.0, sin_dec));
        var dec = Math.asin(sin_dec);

        var cos_dec = Math.cos(dec);
        if (Math.abs(cos_dec) < 1e-9) return null;

        var cos_H = (Math.sin(alt) - sin_dec * Math.sin(lat))
                  / (cos_dec * Math.cos(lat));
        cos_H = Math.max(-1.0, Math.min(1.0, cos_H));
        var H = Math.acos(cos_H);
        if (Math.sin(az) > 0) H = 2 * Math.PI - H;

        var lst = lstHours(date, lon_deg) * 15.0 * DEG;
        var ra  = ((lst - H) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);

        return { ra: ra * RAD, dec: dec * RAD };
    }

    // RA/Dec (degrees) → {az, alt} in degrees
    function equatorialToHoriz(ra_deg, dec_deg, lat_deg, date, lon_deg) {
        var ra  = ra_deg  * DEG;
        var dec = dec_deg * DEG;
        var lat = lat_deg * DEG;
        var lst = lstHours(date, lon_deg) * 15.0 * DEG;
        var H   = lst - ra;

        var sin_alt = Math.sin(dec) * Math.sin(lat)
                    + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
        sin_alt = Math.max(-1.0, Math.min(1.0, sin_alt));
        var alt = Math.asin(sin_alt);

        var cos_alt = Math.cos(alt);
        if (Math.abs(cos_alt) < 1e-9) return null;

        var cos_az = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat))
                   / (cos_alt * Math.cos(lat));
        cos_az = Math.max(-1.0, Math.min(1.0, cos_az));
        var az = Math.acos(cos_az);
        if (Math.sin(H) > 0) az = 2 * Math.PI - az;

        return { az: az * RAD, alt: alt * RAD };
    }

    // -------------------------------------------------------------------------
    // Formatting helpers
    // -------------------------------------------------------------------------

    function raToHM(ra_deg) {
        var h_total = ra_deg / 15.0;
        var h = Math.floor(h_total);
        var m = Math.floor((h_total - h) * 60);
        return h + "h" + String(m).padStart(2, "0") + "m";
    }

    function decToDM(dec_deg) {
        var sign = dec_deg >= 0 ? "+" : "\u2212";
        var abs  = Math.abs(dec_deg);
        var d    = Math.floor(abs);
        var m    = Math.floor((abs - d) * 60);
        return sign + d + "\u00b0" + String(m).padStart(2, "0") + "\u2032";
    }

    function fmtAz(deg) { return "Az\u00a0" + deg.toFixed(1) + "\u00b0"; }
    function fmtEl(deg) { return "El\u00a0"  + deg.toFixed(1) + "\u00b0"; }

    // -------------------------------------------------------------------------
    // Aladin overlay update
    // -------------------------------------------------------------------------

    function drawPointingMarker(ra, dec) {
        if (!pointingOverlay) return;
        pointingOverlay.removeAll();

        // Main beam circle
        pointingOverlay.add(A.circle(ra, dec, BEAM_DEG, { color: "#ff4444", lineWidth: 2 }));

        // Crosshair tickmarks (in RA/Dec space, scaled for cos(dec))
        var tick   = BEAM_DEG * 0.8;
        var gap    = BEAM_DEG * 0.25;
        var cosDec = Math.cos(dec * DEG) || 1e-9;
        var dRA    = tick / cosDec;

        pointingOverlay.add(A.polyline(
            [[ra + (BEAM_DEG + gap) / cosDec, dec], [ra + (BEAM_DEG + gap + dRA) / cosDec, dec]],
            { color: "#ff4444", lineWidth: 1.5 }
        ));
        pointingOverlay.add(A.polyline(
            [[ra - (BEAM_DEG + gap) / cosDec, dec], [ra - (BEAM_DEG + gap + dRA) / cosDec, dec]],
            { color: "#ff4444", lineWidth: 1.5 }
        ));
        pointingOverlay.add(A.polyline(
            [[ra, dec + BEAM_DEG + gap], [ra, dec + BEAM_DEG + gap + tick]],
            { color: "#ff4444", lineWidth: 1.5 }
        ));
        pointingOverlay.add(A.polyline(
            [[ra, dec - BEAM_DEG - gap], [ra, dec - BEAM_DEG - gap - tick]],
            { color: "#ff4444", lineWidth: 1.5 }
        ));
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    function updatePointing(position) {
        if (!position.available) {
            elPointAz.textContent  = "Az: --";
            elPointEl.textContent  = "El: --";
            elPointRa.textContent  = "RA: --";
            elPointDec.textContent = "Dec: --";
            if (pointingOverlay) pointingOverlay.removeAll();
            return;
        }

        var az  = position.azimuth_deg;
        var alt = position.elevation_deg;

        elPointAz.textContent = fmtAz(az);
        elPointEl.textContent = fmtEl(alt);

        var raDec = horizToEquatorial(az, alt, observer.latitude, new Date(), observer.longitude);
        if (!raDec) return;

        lastRaDec = raDec;
        elPointRa.textContent  = "RA\u00a0"  + raToHM(raDec.ra);
        elPointDec.textContent = "Dec\u00a0" + decToDM(raDec.dec);

        drawPointingMarker(raDec.ra, raDec.dec);
    }

    function centerOnPointing() {
        if (aladin && lastRaDec) {
            aladin.gotoRaDec(lastRaDec.ra, lastRaDec.dec);
        }
    }

    // -------------------------------------------------------------------------
    // Initialisation (called from DOMContentLoaded)
    // -------------------------------------------------------------------------

    function init() {
        // Fetch observer lat/lon from server config
        fetch("/api/observer")
            .then(function (r) { return r.json(); })
            .then(function (cfg) { observer = cfg; })
            .catch(function () { /* keep defaults */ });

        // Center button
        var btnCenter = document.getElementById("btn-center-pointing");
        if (btnCenter) btnCenter.addEventListener("click", centerOnPointing);

        // Aladin Lite v3 initialises asynchronously (loads WASM module)
        if (typeof A === "undefined" || !A.init) {
            console.warn("Aladin Lite not loaded — sky map disabled");
            var div = document.getElementById("aladin-div");
            if (div) div.textContent = "Sky map unavailable (CDN not reachable)";
            return;
        }

        A.init.then(function () {
            aladin = A.aladin("#aladin-div", {
                survey: HI4PI_SURVEY,
                fov: 60,
                target: "galactic center",
                cooFrame: "equatorial",
                showCooGridControl: true,
                showSimbadPointerControl: true,
                showSettingsControl: true,
                showLayersControl: true,
                showShareControl: false,
                showFullscreenControl: true,
                showStatusBar: false,
            });

            // Graphic overlay for the telescope pointing marker
            pointingOverlay = A.graphicOverlay({ color: "#ff4444", lineWidth: 2 });
            aladin.addOverlay(pointingOverlay);

            // Click → show Az/El of clicked sky position in Cursor readout
            aladin.on("click", function (ra, dec) {
                if (typeof ra !== "number" || typeof dec !== "number") return;
                var horiz = equatorialToHoriz(ra, dec, observer.latitude, new Date(), observer.longitude);
                if (!horiz) {
                    elCursorAz.textContent = "Az: n/a";
                    elCursorEl.textContent = "El: n/a";
                    return;
                }
                elCursorAz.textContent = fmtAz(((horiz.az % 360) + 360) % 360);
                elCursorEl.textContent = fmtEl(horiz.alt);
            });
        });
    }

    return { init: init, updatePointing: updatePointing };
})();

// Hook sky map init into DOMContentLoaded
document.addEventListener("DOMContentLoaded", skyMap.init);
