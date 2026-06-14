"""Shared helpers for the rt-hardware proxy routers.

Every ``routes_*`` proxy module forwards HTTP to the hardware service and
bridges a WebSocket. Before this module existed, each one hand-rolled the
same four things: grab the pooled ``HardwareClient`` off ``app.state``,
forward a request while mirroring the upstream status/body, return a
structured fallback when the gateway is down, and gate a browser WebSocket
on the queue. Those are collected here so the routers stay declarative and
there is a single place to change forwarding semantics.

All four proxy routers (``routes_motor``, ``routes_spectrum``, ``routes_goes``,
``routes_camera``) forward through these helpers. See
``audits/duplication-audit-2026-06-14.md`` (findings 1 and 2).
"""
from __future__ import annotations

import logging

from fastapi import HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, Response

from rt_platform.api.dependencies import (
    is_lan_admin,
    queue_service,
    read_session_token,
)

logger = logging.getLogger("rt_platform.proxy")


def hardware(request_or_ws) -> "object":
    """Return the shared pooled ``HardwareClient`` bound to this app."""
    return request_or_ws.app.state.hardware_client


def ws_base_url(app) -> str:
    """``ws://`` / ``wss://`` base for opening an upstream bridge socket."""
    return app.state.hardware_client.ws_base_url


async def proxy_json(
    method: str,
    request: Request,
    path: str,
    *,
    json_body: dict | None = None,
    timeout_s: float = 5.0,
    label: str = "Hardware",
) -> JSONResponse:
    """Forward a JSON request to the gateway, mirroring its status and body.

    Raises 502 only when the upstream is unreachable; upstream 4xx/5xx
    responses pass through verbatim so the front-end sees identical error
    semantics to ``local`` mode.
    """
    try:
        r = await hardware(request).request(method, path, json=json_body, timeout=timeout_s)
    except Exception as exc:
        raise HTTPException(502, f"{label} gateway unreachable: {exc}") from exc
    try:
        body = r.json()
    except Exception:
        body = {"detail": r.text}
    return JSONResponse(body, status_code=r.status_code)


async def status_with_fallback(
    request: Request,
    path: str,
    fallback: dict,
    *,
    timeout_s: float = 3.0,
    log_label: str = "Status",
) -> JSONResponse:
    """GET an upstream status endpoint, returning ``fallback`` (200) on failure.

    Status endpoints drive the front-end's auto-reconnect, so an outage must
    render as a structured payload rather than a 5xx.
    """
    try:
        r = await hardware(request).request("GET", path, timeout=timeout_s)
        r.raise_for_status()
        return JSONResponse(r.json())
    except Exception as exc:
        logger.debug("%s proxy failed: %s", log_label, exc)
        return JSONResponse(fallback)


async def binary_passthrough(
    request: Request,
    path: str,
    *,
    timeout_s: float,
    default_media_type: str,
    cache_control: str,
    label: str = "Hardware",
) -> Response:
    """Stream a binary upstream body (image / file) through verbatim."""
    try:
        r = await hardware(request).request("GET", path, timeout=timeout_s)
    except Exception as exc:
        raise HTTPException(502, f"{label} gateway unreachable: {exc}") from exc
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"{label} gateway returned an error")
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", default_media_type),
        headers={"Cache-Control": cache_control},
    )


async def reject_unauthorized_ws(ws: WebSocket) -> bool:
    """Close a browser WS that lacks an active queue session. Returns True if closed.

    No-op when the queue is disabled. LAN admins always pass.
    """
    if not ws.app.state.config.queue.enabled:
        return False
    token = read_session_token(ws)
    if is_lan_admin(ws) or queue_service(ws).is_active(token):
        return False
    await ws.close(code=1008, reason="Active queue session required")
    return True


__all__ = (
    "hardware",
    "ws_base_url",
    "proxy_json",
    "status_with_fallback",
    "binary_passthrough",
    "reject_unauthorized_ws",
)
