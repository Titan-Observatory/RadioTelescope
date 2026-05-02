from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from radiotelescope.hardware.roboclaw import COMMANDS, OPERATOR_COMMAND_IDS, command_registry
from radiotelescope.models.state import CommandInfo, CommandRequest, CommandResult, HealthStatus, RoboClawTelemetry

router = APIRouter(tags=["roboclaw"])


def _service(request: Request):
    return request.app.state.roboclaw_service


@router.get("/api/health", response_model=HealthStatus)
async def health(request: Request):
    service = _service(request)
    return HealthStatus(connection=service.client.connection)


@router.get("/api/roboclaw/status", response_model=RoboClawTelemetry)
async def status(request: Request):
    return _service(request).latest


@router.get("/api/roboclaw/commands", response_model=list[CommandInfo])
async def commands():
    return command_registry()


@router.post("/api/roboclaw/commands/{command_id}", response_model=CommandResult)
async def execute_command(command_id: str, body: CommandRequest, request: Request):
    spec = COMMANDS.get(command_id)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown command: {command_id}")
    if command_id not in OPERATOR_COMMAND_IDS:
        raise HTTPException(status_code=404, detail=f"Command is not available from the web controller: {command_id}")

    client = _service(request).client
    result = await asyncio.to_thread(client.execute, command_id, body.args)
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.error or "RoboClaw command failed")
    return result


@router.post("/api/roboclaw/stop", response_model=dict[str, CommandResult])
async def stop(request: Request):
    return await asyncio.to_thread(_service(request).client.stop_all)


@router.websocket("/ws/roboclaw")
async def roboclaw_ws(ws: WebSocket):
    await ws.accept()
    service = ws.app.state.roboclaw_service
    q = service.subscribe()
    try:
        while True:
            state = await q.get()
            await ws.send_text(state.model_dump_json())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        service.unsubscribe(q)
