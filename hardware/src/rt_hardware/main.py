from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse

from rt_hardware.api import routes_camera, routes_goes, routes_roboclaw, routes_spectrum
from rt_hardware.api.routes_roboclaw import ElevationHomingError, perform_elevation_homing
from rt_hardware.config import load_config
from rt_hardware.goes.pointing import angular_separation_deg, look_angles
from rt_hardware.hardware.roboclaw import make_client
from rt_hardware.models.state import ElevationHomeRequest
from rt_hardware.pointing import compute_fwhm_deg, make_antenna
from rt_hardware.services.camera import CameraService
from rt_hardware.services.goes import GoesService
from rt_hardware.services.roboclaw import RoboClawService
from rt_hardware.services.spectrum import SpectrumService

logger = logging.getLogger("rt_hardware")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = app.state.config

    client = make_client(cfg.roboclaw)

    antenna = make_antenna(cfg.observer)
    app.state.antenna = antenna
    app.state.fwhm_deg = compute_fwhm_deg(cfg.observer)

    service = RoboClawService(client, cfg.telemetry.update_rate_hz, cfg.mount, antenna)
    app.state.roboclaw_service = service

    # The two observation modes are mutually exclusive: each chain owns the
    # one Airspy, so only the mode's service is instantiated. Switching modes
    # means swapping the LNA and restarting with the other config.
    spectrum: SpectrumService | None = None
    goes: GoesService | None = None
    if cfg.observation.mode == "goes":
        goes = GoesService(
            cfg.goes,
            app.state.config_path,
            beam_fwhm_deg=app.state.fwhm_deg,
            pointing_error_deg=_make_pointing_error_fn(cfg, service),
        )
        app.state.goes_service = goes
    elif cfg.sdr.enabled:
        spectrum = SpectrumService(cfg.sdr, app.state.config_path)
        app.state.spectrum_service = spectrum

    camera: CameraService | None = None
    if cfg.camera.enabled:
        camera = CameraService(cfg.camera.device, cfg.camera.width, cfg.camera.height)
        app.state.camera_service = camera

    await service.start()
    for sdr_service, bias_tee_enabled in ((spectrum, cfg.sdr.lna_bias_tee_enabled), (goes, cfg.goes.lna_bias_tee_enabled)):
        if sdr_service is None:
            continue
        # Apply LNA bias-tee during lifespan startup, before the app accepts
        # requests. The GR subprocess is spawned lazily on the first
        # WS subscriber, so at this point nothing holds the Airspy
        # and airspy_gpio has exclusive USB access. Once a subscriber arrives
        # and the subprocess opens Soapy, it owns the device and airspy_gpio
        # would fail — so this must happen here, not later.
        if bias_tee_enabled:
            try:
                status = await sdr_service.apply_configured_bias_tee()
                logger.info("LNA bias tee enabled at boot: %s", status.detail)
            except Exception as exc:
                logger.warning("LNA bias tee could not be applied at boot: %s", exc)
        else:
            logger.info("LNA bias tee disabled (config); not touching hardware")
        await sdr_service.start()

    logger.info(
        "rt-hardware started (hardware=%s, observation=%s)",
        client.connection.mode, cfg.observation.mode,
    )

    if cfg.mount.home_elevation_on_boot:
        if client.connection.mode == "disconnected":
            logger.info("Skipping boot elevation homing: hardware disconnected")
        else:
            speed = ElevationHomeRequest().speed
            logger.info("Boot sequence: homing elevation axis at speed %d", speed)
            try:
                message = await perform_elevation_homing(service, speed)
                logger.info("Boot homing complete: %s", message)
            except ElevationHomingError as exc:
                logger.warning("Boot elevation homing failed: %s", exc)
            except Exception:
                logger.exception("Boot elevation homing raised an unexpected error")

    yield

    if spectrum is not None:
        await spectrum.stop()
    if goes is not None:
        await goes.stop()
    if camera is not None:
        await camera.stop()
    await service.stop()
    logger.info("rt-hardware shut down")


def _make_pointing_error_fn(cfg, service: RoboClawService):
    """Angular separation between the dish and the target GOES satellite.

    Geostationary look angles are fixed for a fixed observer, so they are
    computed once at boot. Returns None until motor telemetry has a solved
    alt/az. Feeds the simulator's acquisition model and is cheap enough to
    call per status frame.
    """
    target = next(s for s in cfg.goes.satellites if s.id == cfg.goes.target_satellite_id)
    angles = look_angles(cfg.observer.latitude_deg, cfg.observer.longitude_deg, target.longitude_deg)

    def pointing_error_deg() -> float | None:
        snap = service.latest
        if snap is None or snap.altitude_deg is None or snap.azimuth_deg is None:
            return None
        return angular_separation_deg(
            snap.altitude_deg, snap.azimuth_deg, angles.elevation_deg, angles.azimuth_deg,
        )

    return pointing_error_deg


def create_app(config_path: str | Path = "config.toml") -> FastAPI:
    cfg = load_config(config_path)
    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    app = FastAPI(title="RT Hardware", lifespan=lifespan)
    app.state.config = cfg
    # The SpectrumService re-loads this path inside the GNU Radio subprocess
    # so its view of the SDR config matches ours exactly.
    app.state.config_path = str(Path(config_path).resolve())

    app.include_router(routes_roboclaw.router)
    app.include_router(routes_spectrum.router)
    # Always included: /api/observation reports the boot mode in both modes;
    # the /api/goes/* surface 404s when the GOES service isn't running.
    app.include_router(routes_goes.router)
    if cfg.camera.enabled:
        app.include_router(routes_camera.router)

    @app.get("/")
    async def index():
        return PlainTextResponse(
            "rt-hardware: motors + SDR + camera. See /docs or /openapi.json.",
        )

    return app


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="RT Hardware Service")
    parser.add_argument("-c", "--config", default="config.toml", help="Path to config.toml")
    args = parser.parse_args()

    app = create_app(args.config)
    cfg = app.state.config
    try:
        uvicorn.run(
            app,
            host=cfg.server.host,
            port=cfg.server.port,
            timeout_graceful_shutdown=3,
            # Disable the legacy `websockets` keepalive ping. The spectrum stream
            # already pushes frames continuously, so the protocol-level ping buys
            # us nothing — and under backpressure its keepalive_ping task races
            # the app's send_json on the same transport's drain(), tripping an
            # asyncio AssertionError that tears the connection down with a 1011.
            ws_ping_interval=None,
            ws_ping_timeout=None,
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
