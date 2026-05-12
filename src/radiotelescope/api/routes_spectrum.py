from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

router = APIRouter(tags=["spectrum"])


class IntegrationUpdate(BaseModel):
    frames: int = Field(ge=1, le=4096)


def _service(request: Request):
    service = getattr(request.app.state, "spectrum_service", None)
    if service is None:
        raise HTTPException(404, "Spectrum service is not running on this host")
    return service


@router.get("/api/spectrum/status")
async def spectrum_status(request: Request):
    service = getattr(request.app.state, "spectrum_service", None)
    if service is None:
        return {"enabled": False, "mode": "disabled"}
    cfg = request.app.state.config.sdr
    return {
        "enabled": cfg.enabled,
        "mode": service.mode,
        "center_freq_mhz": cfg.center_freq_hz / 1e6,
        "sample_rate_mhz": cfg.sample_rate_hz / 1e6,
        "fft_size": cfg.fft_size,
        "integration_frames": cfg.integration_frames,
        "publish_rate_hz": cfg.publish_rate_hz,
    }


@router.get("/api/spectrum/baseline")
async def get_baseline(request: Request):
    service = _service(request)
    baseline = service.load_baseline()
    if baseline is None:
        raise HTTPException(404, "No baseline has been captured yet")
    return baseline


@router.post("/api/spectrum/baseline")
async def capture_baseline(request: Request):
    service = _service(request)
    baseline = service.capture_baseline()
    if baseline is None:
        raise HTTPException(409, "No spectrum frame is available yet to capture")
    return baseline


@router.post("/api/spectrum/integration")
async def set_integration(body: IntegrationUpdate, request: Request):
    n = _service(request).set_integration_frames(body.frames)
    return {"integration_frames": n}


@router.post("/api/spectrum/reset")
async def reset_integration(request: Request):
    _service(request).reset_integration()
    return {"ok": True}


@router.delete("/api/spectrum/baseline")
async def clear_baseline(request: Request):
    _service(request).clear_baseline()
    return {"ok": True}


@router.websocket("/ws/spectrum")
async def spectrum_ws(ws: WebSocket):
    await ws.accept()
    service = getattr(ws.app.state, "spectrum_service", None)
    if service is None:
        await ws.close(code=1011)
        return
    q = service.subscribe()
    try:
        while True:
            frame = await q.get()
            await ws.send_json(frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        service.unsubscribe(q)
