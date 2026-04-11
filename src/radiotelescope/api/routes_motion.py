from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from radiotelescope.models.commands import MoveCommand, StopCommand
from radiotelescope.models.state import MotorState

router = APIRouter(prefix="/api", tags=["motion"])


def _motion(request: Request):
    return request.app.state.motion_service


@router.post("/move", response_model=MotorState)
async def move(cmd: MoveCommand, request: Request):
    try:
        return _motion(request).move(cmd)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/stop", response_model=dict[str, MotorState])
async def stop(cmd: StopCommand, request: Request):
    return _motion(request).stop(cmd)


@router.get("/position", response_model=dict[str, MotorState])
async def position(request: Request):
    return _motion(request).get_state()
