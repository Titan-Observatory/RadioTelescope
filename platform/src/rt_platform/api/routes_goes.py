"""GOES observation-mode proxy.

The hardware service runs ``GoesService`` (demod pipeline, decode chain,
product store) and is the source of truth. The platform forwards the HTTP
calls and bridges ``/ws/goes`` through a ``JsonWsBridge`` — the same split
used for the spectrum surface, so both observation modes stay segregated
end to end.

Auth mirrors the spectrum proxy: viewers (active queue session) can read
status/products and watch the stream; only the controller can bounce the
pipeline or clear the product archive.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response

from rt_platform.api.dependencies import (
    is_lan_admin,
    queue_service,
    read_session_token,
    require_active_queue_session,
    require_control,
)

logger = logging.getLogger("radiotelescope.goes_proxy")
router = APIRouter(tags=["goes-proxy"])


def _hardware(request: Request):
    return request.app.state.hardware_client


async def _proxy_json(
    method: str,
    request: Request,
    path: str,
    timeout_s: float = 5.0,
) -> JSONResponse:
    """Forward a JSON request to the hardware service, mirroring status + body."""
    try:
        r = await _hardware(request).request(method, path, timeout=timeout_s)
    except Exception as exc:
        raise HTTPException(502, f"GOES gateway unreachable: {exc}") from exc
    try:
        body = r.json()
    except Exception:
        body = {"detail": r.text}
    return JSONResponse(body, status_code=r.status_code)


@router.get("/api/observation", dependencies=[Depends(require_active_queue_session)])
async def observation_info(request: Request) -> JSONResponse:
    """Which observation mode the hardware booted in — drives panel selection.

    Falls back to hydrogen-line when the gateway is unreachable so the UI
    always has a render path; ``degraded`` flags the fallback.
    """
    try:
        r = await _hardware(request).request("GET", "/api/observation", timeout=3.0)
        r.raise_for_status()
        return JSONResponse(r.json())
    except Exception as exc:
        logger.debug("Observation info proxy failed: %s", exc)
        return JSONResponse({"mode": "hydrogen_line", "satellites": [], "degraded": True})


@router.get("/api/goes/status", dependencies=[Depends(require_active_queue_session)])
async def goes_status(request: Request) -> JSONResponse:
    try:
        r = await _hardware(request).request("GET", "/api/goes/status", timeout=3.0)
        r.raise_for_status()
        return JSONResponse(r.json())
    except Exception as exc:
        logger.debug("GOES status proxy failed: %s", exc)
        return JSONResponse({"enabled": True, "mode": "disconnected", "fault_detail": "Gateway unreachable"})


@router.post("/api/goes/reconnect", dependencies=[Depends(require_control)])
async def goes_reconnect(request: Request) -> JSONResponse:
    # Bouncing the demod pipeline takes a few seconds; allow for it.
    return await _proxy_json("POST", request, "/api/goes/reconnect", timeout_s=15.0)


@router.get("/api/goes/products", dependencies=[Depends(require_active_queue_session)])
async def list_products(request: Request) -> JSONResponse:
    limit = request.query_params.get("limit", "60")
    return await _proxy_json("GET", request, f"/api/goes/products?limit={limit}")


@router.get("/api/goes/products/{product_id}", dependencies=[Depends(require_active_queue_session)])
async def product_meta(product_id: str, request: Request) -> JSONResponse:
    return await _proxy_json("GET", request, f"/api/goes/products/{product_id}")


@router.get("/api/goes/products/{product_id}/file", dependencies=[Depends(require_active_queue_session)])
async def product_file(product_id: str, request: Request) -> Response:
    """Binary passthrough for decoded product files (images, bulletins)."""
    try:
        r = await _hardware(request).request(
            "GET", f"/api/goes/products/{product_id}/file", timeout=20.0,
        )
    except Exception as exc:
        raise HTTPException(502, f"GOES gateway unreachable: {exc}") from exc
    if r.status_code >= 400:
        raise HTTPException(r.status_code, "GOES gateway returned an error")
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "application/octet-stream"),
        # Products are immutable once decoded; let the browser cache them.
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.delete("/api/goes/products", dependencies=[Depends(require_control)])
async def clear_products(request: Request) -> JSONResponse:
    return await _proxy_json("DELETE", request, "/api/goes/products")


@router.websocket("/ws/goes")
async def goes_ws(ws: WebSocket):
    """Re-publish GOES status frames from the host-side bridge to a browser."""
    await ws.accept()
    if ws.app.state.config.queue.enabled:
        token = read_session_token(ws)
        if not (is_lan_admin(ws) or queue_service(ws).is_active(token)):
            await ws.close(code=1008, reason="Active queue session required")
            return
    bridge = getattr(ws.app.state, "goes_bridge", None)
    if bridge is None:
        await ws.close(code=1011)
        return
    q = bridge.subscribe()
    try:
        while True:
            frame = await q.get()
            await ws.send_json(frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        bridge.unsubscribe(q)
