from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from radiotelescope.models.state import SDRStatus, SessionStatus
from radiotelescope.services.session import require_session

router = APIRouter(tags=["sdr"])


# ---------- SDR lifecycle ----------

@router.post("/api/sdr/start", dependencies=[Depends(require_session)])
async def sdr_start(request: Request):
    svc = request.app.state.spectrum_service
    if svc.is_running:
        return {"status": "already_running"}
    await svc.start()
    return {"status": "started"}


@router.post("/api/sdr/stop", dependencies=[Depends(require_session)])
async def sdr_stop(request: Request):
    svc = request.app.state.spectrum_service
    await svc.stop()
    return {"status": "stopped"}


@router.get("/api/sdr/status", response_model=SDRStatus)
async def sdr_status(request: Request):
    svc = request.app.state.spectrum_service
    cfg = request.app.state.config.sdr
    return SDRStatus(
        running=svc.is_running,
        center_freq_hz=cfg.center_freq_hz,
        sample_rate_hz=cfg.sample_rate_hz,
        gain=cfg.gain,
        fft_size=cfg.fft_size,
        integration_count=cfg.integration_count,
        rolling_window_s=svc._rolling_window_s,
    )


class _IntegrationWindowRequest(BaseModel):
    window_s: float = Field(ge=0, le=300)


@router.post("/api/sdr/integration", dependencies=[Depends(require_session)])
async def sdr_set_integration(body: _IntegrationWindowRequest, request: Request):
    request.app.state.spectrum_service.set_rolling_window(body.window_s)
    return {"window_s": body.window_s}


# ---------- Session management ----------

class _ClaimRequest(BaseModel):
    client_id: str


@router.post("/api/session/claim")
async def session_claim(body: _ClaimRequest, request: Request):
    svc = request.app.state.session_service
    token = svc.claim(body.client_id)
    return {"token": token}


@router.post("/api/session/release", dependencies=[Depends(require_session)])
async def session_release(request: Request):
    token = request.headers.get("X-Session-Token", "")
    request.app.state.session_service.release(token)
    return {"status": "released"}


@router.get("/api/session/status", response_model=SessionStatus)
async def session_status(request: Request):
    return request.app.state.session_service.get_status()
