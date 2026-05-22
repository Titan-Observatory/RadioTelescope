# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend install (editable, with dev deps)
pip install -e ".[dev]"

# Frontend install + build (required for serving the UI from the backend)
cd frontend && npm install && npm run build

# Run server
radiotelescope -c config.toml

# Frontend dev server (Vite, hot reload at :5173, proxies API to :8000)
cd frontend && npm run dev

# Run all tests
pytest

# Run single test file or filter
pytest tests/test_roboclaw_service.py
pytest -k "test_goto"
```

## Architecture

Layered: hardware → services → API → React frontend. There is no separate "safety layer"; limit checks live in the routes/service that need them.

**Deployment modes** (`HardwareConfig.mode`):
- `local` — single box owns hardware and UI.
- `gateway-server` — Pi owns motor/SDR/camera, exposes hardware routes only; headless.
- `gateway-client` — separate host runs the UI and DSP, talks to a `gateway-server` over LAN. Uses `RemoteRoboClawClient` (HTTP/WS to the Pi) and `SpectrumBridge` (subscribes once to the Pi's `/ws/spectrum` and fans frames out to browsers, since the Pi 3B+'s 100 Mbps NIC can't carry raw IQ).

**Startup flow** (`main.py` lifespan):
1. Build a `RoboClawClient` (local serial via `make_client`, or `RemoteRoboClawClient` in `gateway-client` mode).
2. Build a `katpoint.Antenna` from `[observer]` config; stash it on `app.state.antenna`.
3. Instantiate `RoboClawService(client, update_rate_hz, mount_cfg, antenna)` and `QueueService`.
4. In `local`/`gateway-server` mode with `sdr.enabled`, instantiate `SpectrumService(SDRReceiver(cfg.sdr), cfg.sdr)`. In `gateway-client` mode, instantiate `SpectrumBridge` instead.
5. Start each service's background task. All instances live on `app.state`.

**Hardware layer** (`hardware/`):
- `roboclaw.py` — Packet Serial driver for a RoboClaw motor controller over USB serial (`/dev/ttyACM0` by default, address 0x80). Two motors (M1 = azimuth, M2 = elevation). Command registry pattern: each operation is a `CommandSpec` with typed args and a response decoder; `COMMANDS` / `OPERATOR_COMMAND_IDS` enumerate what the API exposes. Encoder counts are the source of position truth — no separate INA226 current sensor; battery/current/temperature come from RoboClaw status reads.
- `remote.py` — `RemoteRoboClawClient`: same interface as the local client, but sends commands over HTTP and subscribes to `/ws/roboclaw` on the gateway.
- `sdr.py` — `SDRReceiver` wraps SoapySDR's `airspy` driver. Bridges blocking `readStream` onto asyncio via `to_thread`. Supports optional 4.5 V bias tee for an inline LNA.
- `host_stats.py` — CPU/memory/temp readers folded into the telemetry payload.

**Service layer** (`services/`):
- `RoboClawService` — owns the client, polls telemetry at `telemetry.update_rate_hz` (default 5 Hz), serialises all I/O behind an `asyncio.Lock`, broadcasts `RoboClawTelemetry` via `Broadcaster`. Tracks active position targets so the poll loop can stop motion on arrival, and runs a jog watchdog. Computes RA/Dec each tick (via `pointing.altaz_to_radec`) when an antenna is configured.
- `SpectrumService` — pulls IQ from `SDRReceiver`, computes Hann-windowed FFTs, maintains an EMA-integrated spectrum, and broadcasts `SpectrumFrame` dicts. Persists the baseline to `spectrum_baseline.json` next to the launch dir.
- `SpectrumBridge` — subscriber-only counterpart used by `gateway-client`; reuses the same broadcaster pattern.
- `QueueService` — multi-user control queue with session cookies, per-IP caps, idle timeouts, and a join cooldown.
- `geometry.py` — encoder-counts ↔ altitude conversions, including the empirical `AltitudeCalibrationConfig` (2 points → linear, 3+ → quadratic) when configured.
- `_pubsub.py` — `Broadcaster[T]` is the drop-oldest fan-out used by every telemetry stream.

**Pointing** (`pointing.py`): thin wrapper around `katpoint`. `make_antenna(ObserverConfig)` builds the antenna; `altaz_to_radec` / `radec_to_altaz` do J2000 conversions at the current timestamp; `compute_fwhm_deg` returns the beam from dish + observing frequency unless overridden.

**Geometry** (`geometry.py`): pure-Python azimuth wrapping (`normalise_azimuth`, `unwrap_azimuth`) and a `point_in_triangle` test used by the optional `pointing_limit_altaz` keep-out triangle. A TypeScript copy lives in `frontend/src/lib/altaz.ts` and is kept manually in sync.

**API** (`api/`): FastAPI routers wired in `main.py` based on the deployment mode.
- Motor / telescope (`routes_roboclaw.py`): `GET /api/health`, `GET /api/roboclaw/status`, `GET /api/roboclaw/commands`, `POST /api/roboclaw/commands/{id}`, `POST /api/roboclaw/stop`, `POST /api/telescope/jog`, `POST /api/telescope/jog/stop`, `GET|POST /api/telescope/goto`, `POST /api/telescope/goto_radec`, `POST /api/telescope/sync`, `GET /api/telescope/config`, `POST /api/telescope/home/{elevation,azimuth,altitude}`, `WS /ws/roboclaw`. Motion endpoints write a JSONL audit log to `motion.jsonl`.
- Spectrum (`routes_spectrum.py` / `routes_spectrum_proxy.py`): status, baseline get/post/delete, reset, reconnect, LNA bias-tee toggle, `WS /ws/spectrum`. The proxy variant is mounted in `gateway-client` mode.
- Queue (`routes_queue.py`): config, status, join, leave, `WS /ws/queue`.
- Camera (`routes_camera.py` / `routes_camera_proxy.py`): MJPEG stream + status; proxy variant for `gateway-client`.
- Auth (`auth.py`): optional password gate (`AuthManager` + `PasswordAuthMiddleware`) with lockout. Login routes are excluded from the schema.
- Feedback / events (`routes_feedback.py`, `routes_events.py`): JSONL append-only logs.
- Cross-cutting middleware: `SecurityHeadersMiddleware`, `RateLimitMiddleware`, `CORSMiddleware`, `ClientAllowlistMiddleware`, `PasswordAuthMiddleware`. Auth helpers: `require_control` (must hold the queue), `require_lan_admin` / `is_lan_admin` (LAN-only admin override).

**Models** (`models/state.py`): single source of truth for request and response shapes — `RoboClawTelemetry`, `CommandInfo`/`CommandResult`/`CommandRequest`, `AltAzRequest`/`RaDecRequest`, `JogRequest`/`JogStopRequest`, `ElevationHomeRequest`, `TelescopeConfig`, `HealthStatus`, `AltAzPoint`, `PollStats`, `ConnectionStatus`. `scripts/dump_types.py` re-emits these as TypeScript for the frontend.

**Config** (`config.py`): Pydantic v2 loaded from TOML, with `${ENV_VAR:-default}` expansion so secrets come from the systemd `EnvironmentFile`. Top-level sections: `general`, `hardware`, `roboclaw`, `telemetry`, `mount`, `server`, `rate_limit`, `observer`, `camera`, `sdr`, `queue`, `turnstile`, `auth`, plus the feedback / events / motion log paths. `public_exposure_errors(cfg)` runs at startup and refuses to boot a public-facing bind that has placeholder secrets, wildcard CORS, no Turnstile, etc.

**Frontend** (`frontend/`): Vite + React + TypeScript. `LiveShell.tsx` is the root; subdirs are `components/`, `ui/`, `ws/` (telemetry/spectrum/queue WebSocket clients), `lib/` (incl. the synced `altaz.ts`), `types/` (auto-generated from `dump_types.py`). Build output goes to `frontend/dist/` and the backend serves it from `/`. A SPA fallback route serves `index.html` for unknown GETs.

## Testing

Tests use `pytest-asyncio` with `asyncio_mode = "auto"`. Hardware is faked by `tests/fake_roboclaw.py::SimulatedRoboClaw` — the `simulated_config_path` fixture monkey-patches `radiotelescope.main.make_client` to return it. No real hardware needed.

## Hardware Notes (Raspberry Pi)

- Motors: RoboClaw 2xN over USB serial (Packet Serial mode, default address 0x80, 38400 baud). Encoders are the only source of position — calibrate `mount.az_counts_per_degree`, `alt_counts_per_degree`, zero offsets, and (optionally) `altitude_calibration.points` for a non-linear elevation axis.
- SDR: SoapySDR Airspy driver. Install on the Pi with `sudo apt install soapysdr-module-airspy python3-soapysdr` (bindings aren't on PyPI). Verify with `SoapySDRUtil --probe="driver=airspy"`. Airspy Mini sample rate must be 3 Msps or 6 Msps.
- Camera: V4L2 device via OpenCV; configured under `[camera]`.
- `setuptools<72` required on Python 3.13 for `pkg_resources` availability.
