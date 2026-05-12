from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["iq"])


@router.websocket("/ws/iq")
async def iq_ws(ws: WebSocket):
    """Stream raw `uint8` I/Q pairs from the SDR to a gateway-client host.

    Mounted only when `hardware.mode == "gateway-server"`. The wire format
    is interleaved I,Q,I,Q,... bytes; the consumer is responsible for
    chunking into FFT-sized frames if it cares.
    """
    await ws.accept()
    publisher = getattr(ws.app.state, "iq_publisher", None)
    if publisher is None:
        await ws.close(code=1011)
        return
    q = publisher.subscribe()
    try:
        while True:
            payload = await q.get()
            await ws.send_bytes(payload)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        publisher.unsubscribe(q)
