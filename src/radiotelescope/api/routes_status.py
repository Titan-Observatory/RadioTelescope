from __future__ import annotations

from fastapi import APIRouter, Request

from radiotelescope.models.state import TelescopeState

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/status", response_model=TelescopeState)
async def status(request: Request):
    return request.app.state.telemetry_service.latest_state()


@router.get("/health")
async def health(request: Request):
    return {"status": "ok"}


@router.post("/safety/reset")
async def safety_reset(request: Request):
    request.app.state.safety_monitor.reset()
    return {"status": "reset"}
