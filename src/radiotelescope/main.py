from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from radiotelescope.api import routes_roboclaw, routes_terminal
from radiotelescope.config import load_config
from radiotelescope.hardware.roboclaw import make_client
from radiotelescope.services.roboclaw import RoboClawService

logger = logging.getLogger("radiotelescope")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = app.state.config
    client = make_client(cfg.roboclaw)
    service = RoboClawService(client, cfg.telemetry.update_rate_hz)
    app.state.roboclaw_service = service

    await service.start()
    logger.info("RoboClaw controller started in %s mode", client.connection.mode)
    yield
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

    app.include_router(routes_roboclaw.router)
    app.include_router(routes_terminal.router)

    frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if frontend_dist.exists():
        app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")

        @app.get("/")
        async def serve_index():
            return FileResponse(frontend_dist / "index.html")

    return app


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="RoboClaw Controller")
    parser.add_argument("-c", "--config", default="config.toml", help="Path to config.toml")
    args = parser.parse_args()

    app = create_app(args.config)
    cfg = app.state.config
    uvicorn.run(app, host=cfg.server.host, port=cfg.server.port)


if __name__ == "__main__":
    cli()
