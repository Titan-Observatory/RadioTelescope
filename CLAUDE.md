# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install (editable, with dev deps)
pip install -e ".[dev]"

# Run server
radiotelescope -c config.toml

# Run all tests
pytest

# Run single test file or filter
pytest tests/test_motor.py
pytest -k "test_overcurrent"
```

## Architecture

Layered architecture: hardware → safety → services → API → static frontend.

**Startup flow** (`main.py` lifespan):
1. Open lgpio handle → instantiate `IBT2Motor` (azimuth, elevation), `INA226`, `SDRReceiver`
2. Wire into `SafetyMonitor`, `MotionService`, `TelemetryService`, `SpectrumService`
3. Start `TelemetryService` background polling loop
4. All instances live on `app.state`

**Hardware layer** (`hardware/`):
- `IBT2Motor` — IBT-2/BTS7960 H-bridge via lgpio PWM. Async duty ramping; direction changes trigger hard stop to prevent shoot-through.
- `INA226` — I2C current/power sensor (smbus2). Retries every 2 s on fault; returns `SensorReading(available=False)` rather than raising.
- `SDRReceiver` — wraps pyrtlsdr `RtlSdrAio`; async sample streaming.

**Safety layer** (`safety/interlocks.py`):
- `SafetyMonitor` is a *passive checker*, not a background loop.
- `check_current(reading)` — called by `TelemetryService` each poll tick; trips on sustained overcurrent.
- `check_limits(axis, target_deg)` — called by `MotionService` before every move.
- Trip state is sticky until `reset()` is called via `POST /api/safety/reset`.

**Service layer** (`services/`):
- `MotionService` — routes move/stop commands, enforces safety before acting.
- `TelemetryService` — 10 Hz poll loop; publishes `TelescopeState` to `asyncio.Queue` subscribers (drop-oldest on full).
- `SpectrumService` — accumulates SDR samples, computes Hann-windowed FFT, encodes as base64 float32; same pub/sub pattern as TelemetryService.

**API** (`api/`): thin FastAPI routers that pull services off `app.state`.
- Motion: `POST /api/move`, `POST /api/stop`, `GET /api/position`
- Status: `GET /api/status`, `GET /api/health`, `POST /api/safety/reset`
- WebSockets: `/ws/telemetry` (TelescopeState at 10 Hz), `/ws/spectrum` (SpectrumFrame)

**Models** (`models/`):
- `state.py` — response shapes: `MotorState`, `SensorReading`, `SafetyStatus`, `TelescopeState`
- `commands.py` — request shapes: `MoveCommand`, `StopCommand`, `SDRTuneCommand`

**Config** (`config.py`): Pydantic v2 models loaded from TOML via `load_config(path)`. Top-level key `[motors]` has sub-keys `azimuth` and `elevation`; each maps to `MotorConfig`.

**Frontend** (`static/`): Vanilla JS/HTML/CSS, no build step. Connects to `/ws/telemetry` with auto-reconnect; calls REST endpoints for motor commands and safety reset. Spectrum panel is a placeholder pending SDR API endpoints.

## Testing

Tests use `pytest-asyncio` (`asyncio_mode = "auto"` in pyproject.toml). Hardware dependencies are fully mocked in `tests/conftest.py` — `mock_motor` patches lgpio, `mock_ina226` returns fixed `SensorReading` values. No real hardware is needed to run the test suite.

## Hardware Notes (Raspberry Pi)

- GPIO via `lgpio`; I2C via `smbus2` on bus 1 (default)
- `pyrtlsdr==0.3.0` must be pinned exactly — PyPI 0.3.0 works with standard `librtlsdr`; later unreleased versions require `rtlsdr_set_dithering` which is absent from most system builds
- `setuptools<72` required on Python 3.13 for `pkg_resources` availability
- INA226 defaults to I2C address `0x40`; configure shunt resistor ohms in `config.toml`
