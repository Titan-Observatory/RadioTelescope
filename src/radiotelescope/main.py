from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import lgpio
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from radiotelescope.api import routes_config, routes_motion, routes_sdr, routes_status, ws
from radiotelescope.config import load_config
from radiotelescope.hardware.current_sensor import INA226
from radiotelescope.hardware.motor import IBT2Motor
from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.safety.interlocks import SafetyMonitor
from radiotelescope.services.motion import MotionService
from radiotelescope.services.session import SessionService
from radiotelescope.services.spectrum import SpectrumService
from radiotelescope.services.telemetry import TelemetryService

logger = logging.getLogger("radiotelescope")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = app.state.config

    # Hardware
    handle = lgpio.gpiochip_open(0)

    motors = {
        "azimuth": IBT2Motor(cfg.motors.azimuth, handle),
        "elevation": IBT2Motor(cfg.motors.elevation, handle),
    }
    ina226 = INA226(cfg.i2c)
    sdr = SDRReceiver(cfg.sdr)

    # Safety
    safety = SafetyMonitor(cfg.safety, ina226)

    # Services
    motion = MotionService(motors, safety)
    telemetry = TelemetryService(ina226, safety, motion, cfg.general.update_rate_hz)
    spectrum = SpectrumService(sdr, cfg.sdr)
    session = SessionService()

    # Store on app.state for route access
    app.state.safety_monitor = safety
    app.state.motion_service = motion
    app.state.telemetry_service = telemetry
    app.state.spectrum_service = spectrum
    app.state.session_service = session

    await telemetry.start()
    await session.start()
    # Spectrum starts on demand via POST /api/sdr/start (SDR may not be plugged in at boot)

    logger.info("Telescope controller started")
    yield

    # Shutdown
    await session.stop()
    await spectrum.stop()
    await telemetry.stop()
    for m in motors.values():
        m.cleanup()
    ina226.close()
    lgpio.gpiochip_close(handle)
    logger.info("Telescope controller shut down")


def create_app(config_path: str | Path = "config.toml") -> FastAPI:
    cfg = load_config(config_path)

    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    app = FastAPI(title="Radio Telescope Controller", lifespan=lifespan)
    app.state.config = cfg

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.server.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(routes_motion.router)
    app.include_router(routes_status.router)
    app.include_router(routes_sdr.router)
    app.include_router(routes_config.router)
    app.include_router(ws.router)

    # Dev web UI — static files served from package
    static_dir = Path(__file__).parent / "static"

    @app.get("/")
    async def serve_index():
        return FileResponse(static_dir / "index.html")

    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    return app


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Radio Telescope Controller")
    parser.add_argument("-c", "--config", default="config.toml", help="Path to config.toml")
    args = parser.parse_args()

    app = create_app(args.config)
    cfg = app.state.config
    uvicorn.run(app, host=cfg.server.host, port=cfg.server.port)


if __name__ == "__main__":
    cli()
