from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)


@router.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    svc = ws.app.state.telemetry_service
    q = svc.subscribe()
    try:
        while True:
            state = await q.get()
            await ws.send_text(state.model_dump_json())
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
