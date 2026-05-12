from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from radiotelescope.api import routes_camera, routes_queue, routes_roboclaw, routes_spectrum
from radiotelescope.api.client_allowlist import ClientAllowlistMiddleware
from radiotelescope.config import load_config
from radiotelescope.hardware.roboclaw import make_client
from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.pointing import compute_fwhm_deg, make_antenna
from radiotelescope.services.queue import QueueService
from radiotelescope.services.roboclaw import RoboClawService
from radiotelescope.services.spectrum import SpectrumService

logger = logging.getLogger("radiotelescope")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = app.state.config
    client = make_client(cfg.roboclaw)
    antenna = make_antenna(cfg.observer)
    app.state.antenna = antenna
    app.state.fwhm_deg = compute_fwhm_deg(cfg.observer)
    service = RoboClawService(client, cfg.telemetry.update_rate_hz, cfg.mount, antenna)
    app.state.roboclaw_service = service

    queue = QueueService(
        max_session_seconds=cfg.queue.max_session_seconds,
        idle_timeout_seconds=cfg.queue.idle_timeout_seconds,
        max_queue_size=cfg.queue.max_queue_size,
    )
    app.state.queue_service = queue

    spectrum: SpectrumService | None = None
    if cfg.sdr.enabled:
        spectrum = SpectrumService(SDRReceiver(cfg.sdr), cfg.sdr)
        app.state.spectrum_service = spectrum

    await service.start()
    await queue.start()
    if spectrum is not None:
        await spectrum.start()
    logger.info("RoboClaw controller started in %s mode", client.connection.mode)
    yield
    if spectrum is not None:
        await spectrum.stop()
    await queue.stop()
    await service.stop()
    logger.info("RoboClaw controller shut down")


def create_app(config_path: str | Path = "config.toml") -> FastAPI:
    cfg = load_config(config_path)

    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    app = FastAPI(title="RoboClaw Controller", lifespan=lifespan)
    app.state.config = cfg

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.server.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(
        ClientAllowlistMiddleware,
        allowed_clients=cfg.server.allowed_clients,
        block_unknown=cfg.server.lan_only,
    )

    app.include_router(routes_roboclaw.router)
    app.include_router(routes_queue.router)
    app.include_router(routes_camera.router)
    app.include_router(routes_spectrum.router)

    frontend_dist = _find_frontend_dist()
    if frontend_dist.exists():
        app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")

        @app.get("/")
        async def serve_index():
            return FileResponse(frontend_dist / "index.html")

        @app.get("/{path:path}")
        async def serve_spa(path: str):
            target = frontend_dist / path
            if target.is_file():
                return FileResponse(target)
            return FileResponse(frontend_dist / "index.html")
    else:
        logger.warning("Frontend build not found; run `npm run build` in frontend/ before using port 8000 for the UI")

        @app.get("/")
        async def missing_frontend():
            return PlainTextResponse(
                "RoboClaw backend is running, but the web UI has not been built. "
                "Run `cd frontend && npm run build`, then restart the backend. "
                "For development, use the Vite UI at http://<host>:5173/.",
                status_code=503,
            )

    return app


def _find_frontend_dist() -> Path:
    candidates = [
        Path.cwd() / "frontend" / "dist",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
        Path(__file__).resolve().parent / "frontend" / "dist",
    ]
    for candidate in candidates:
        if (candidate / "index.html").exists():
            return candidate
    return candidates[0]


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="RoboClaw Controller")
    parser.add_argument("-c", "--config", default="config.toml", help="Path to config.toml")
    args = parser.parse_args()

    app = create_app(args.config)
    cfg = app.state.config
    uvicorn.run(
        app,
        host=cfg.server.host,
        port=cfg.server.port,
        proxy_headers=True,
        forwarded_allow_ips=",".join(cfg.server.trusted_proxies),
    )


if __name__ == "__main__":
    cli()
