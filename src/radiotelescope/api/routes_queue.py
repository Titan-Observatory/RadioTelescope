from __future__ import annotations

import asyncio
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from radiotelescope.api.dependencies import (
    client_ip,
    queue_service,
    read_session_token,
    write_session_token,
)
from radiotelescope.services.queue import QueueFullError, QueueStatus

logger = logging.getLogger(__name__)
router = APIRouter(tags=["queue"])

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


class JoinRequest(BaseModel):
    turnstile_token: str | None = None


class QueueConfigResponse(BaseModel):
    enabled: bool
    turnstile_site_key: str
    turnstile_enabled: bool
    max_session_seconds: int
    idle_timeout_seconds: int


@router.get("/api/queue/config", response_model=QueueConfigResponse)
async def queue_config(request: Request) -> QueueConfigResponse:
    cfg = request.app.state.config
    return QueueConfigResponse(
        enabled=cfg.queue.enabled,
        turnstile_enabled=cfg.turnstile.enabled,
        turnstile_site_key=cfg.turnstile.site_key,
        max_session_seconds=cfg.queue.max_session_seconds,
        idle_timeout_seconds=cfg.queue.idle_timeout_seconds,
    )


@router.get("/api/queue/status", response_model=QueueStatus)
async def queue_status(request: Request) -> QueueStatus:
    token = read_session_token(request)
    return queue_service(request).status_for(token)


@router.post("/api/queue/join", response_model=QueueStatus)
async def queue_join(body: JoinRequest, request: Request, response: Response) -> QueueStatus:
    cfg = request.app.state.config
    queue = queue_service(request)

    if cfg.turnstile.enabled and cfg.turnstile.secret_key:
        if not body.turnstile_token:
            raise HTTPException(400, "Captcha token missing")
        if not await _verify_turnstile(
            secret=cfg.turnstile.secret_key,
            token=body.turnstile_token,
            remote_ip=client_ip(request),
        ):
            raise HTTPException(403, "Captcha verification failed")

    existing = read_session_token(request)
    if existing is not None and await queue.rejoin(existing, client_ip(request) or ""):
        return queue.status_for(existing)

    try:
        token = await queue.join(client_ip(request) or "unknown")
    except QueueFullError as exc:
        raise HTTPException(503, str(exc)) from exc

    write_session_token(response, request, token)
    return queue.status_for(token)


@router.post("/api/queue/leave")
async def queue_leave(request: Request, response: Response) -> dict[str, str]:
    cfg = request.app.state.config.queue
    token = read_session_token(request)
    if token is not None:
        await queue_service(request).leave(token)
    response.delete_cookie(cfg.cookie_name, path="/")
    return {"status": "ok"}


@router.websocket("/ws/queue")
async def queue_ws(ws: WebSocket) -> None:
    await ws.accept()
    queue = queue_service(ws)

    token = read_session_token(ws)
    if token is None:
        await ws.send_json({"error": "not_in_queue"})
        await ws.close(code=1008)
        return

    await queue.mark_ws_connected(token, True)
    listener = queue.subscribe()

    async def _send_loop() -> None:
        await ws.send_json(queue.status_for(token).model_dump())
        while True:
            try:
                await asyncio.wait_for(listener.get(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            await ws.send_json(queue.status_for(token).model_dump())

    async def _recv_loop() -> None:
        # Any inbound message is treated as a UI-activity heartbeat; the
        # frontend throttles clicks / scrolls / keypresses into these pings
        # so the idle countdown isn't tied solely to control commands.
        while True:
            await ws.receive_text()
            await queue.mark_command(token)

    try:
        await asyncio.gather(_send_loop(), _recv_loop())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        queue.unsubscribe(listener)
        await queue.mark_ws_connected(token, False)


async def _verify_turnstile(secret: str, token: str, remote_ip: str | None) -> bool:
    payload = {"secret": secret, "response": token}
    if remote_ip:
        payload["remoteip"] = remote_ip
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(TURNSTILE_VERIFY_URL, data=payload)
        data = resp.json()
        if not data.get("success"):
            logger.warning("Turnstile verification failed: %s", data.get("error-codes"))
        return bool(data.get("success"))
    except Exception:
        logger.exception("Turnstile verification raised")
        return False
