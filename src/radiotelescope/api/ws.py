from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)


@router.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    svc = ws.app.state.telemetry_service
    session_svc = ws.app.state.session_service
    q = svc.subscribe()

    async def _send_loop():
        while True:
            state = await q.get()
            await ws.send_text(state.model_dump_json())

    async def _recv_loop():
        while True:
            try:
                text = await ws.receive_text()
                msg = json.loads(text)
                if msg.get("type") == "heartbeat":
                    session_svc.heartbeat(msg.get("token", ""))
            except Exception:
                break

    try:
        await asyncio.gather(_send_loop(), _recv_loop())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        svc.unsubscribe(q)


@router.websocket("/ws/spectrum")
async def ws_spectrum(ws: WebSocket):
    await ws.accept()
    svc = ws.app.state.spectrum_service
    q = svc.subscribe()
    try:
        while True:
            frame = await q.get()
            await ws.send_text(frame.model_dump_json())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        svc.unsubscribe(q)
