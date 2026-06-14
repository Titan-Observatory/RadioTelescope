"""Camera proxy.

The camera is plugged into the hardware host. The platform exposes the same
`/api/camera/*` URLs the frontend already uses and pipes them through to the
hardware service. Browser-side code never has to know the camera isn't local.

The status + single-frame endpoints share the common forwarding plumbing in
``_proxy``. The MJPEG stream is special — its ``httpx`` client lifecycle is
tied to the long-lived response — so it stays hand-rolled here.
"""
from __future__ import annotations

from typing import AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from rt_platform.api import _proxy

router = APIRouter(tags=["camera-proxy"])


def _base_url(request: Request) -> str:
    return request.app.state.config.hardware_url


@router.get("/api/camera/status")
async def camera_status(request: Request) -> JSONResponse:
    return await _proxy.status_with_fallback(
        request, "/api/camera/status",
        {"enabled": False, "label": "Cam A"},
        log_label="Camera status",
    )


@router.get("/api/camera/frame")
async def camera_frame(request: Request) -> Response:
    """Single-shot JPEG proxy. Short timeout so a stalled hardware fetch
    doesn't pin a connection — the browser polls anyway, it'll retry."""
    return await _proxy.binary_passthrough(
        request, "/api/camera/frame",
        timeout_s=4.0,
        default_media_type="image/jpeg",
        cache_control="no-store",
        label="Camera",
    )


@router.get("/api/camera/stream")
async def camera_stream(request: Request) -> StreamingResponse:
    url = _base_url(request) + "/api/camera/stream"

    # `httpx.AsyncClient` lifecycle is tied to the stream; closing the client
    # too early kills the response mid-flight. Bind both to the generator.
    client = httpx.AsyncClient(timeout=None)
    try:
        req = client.build_request("GET", url)
        upstream = await client.send(req, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(502, f"Camera gateway unreachable: {exc}")
    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(upstream.status_code, "Camera gateway returned an error")

    media_type = upstream.headers.get("content-type", "multipart/x-mixed-replace; boundary=frame")

    async def _relay() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw():
                if await request.is_disconnected():
                    break
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(_relay(), media_type=media_type)
