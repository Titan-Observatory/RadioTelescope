"""Shared helpers for the rt-hardware proxy routers.

Every ``routes_*`` proxy module forwards HTTP to the hardware service and
bridges a WebSocket. Before this module existed, each one hand-rolled the
same four things: grab the pooled ``HardwareClient`` off ``app.state``,
forward a request while mirroring the upstream status/body, return a
structured fallback when the gateway is down, and gate a browser WebSocket
on the queue. Those are collected here so the routers stay declarative and
there is a single place to change forwarding semantics.

All four proxy routers (``routes_motor``, ``routes_spectrum``, ``routes_goes``,
``routes_camera``) forward through these helpers.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
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


@dataclass(frozen=True)
class ProxyRoute:
    """One straight pass-through endpoint, declared instead of hand-written.

    Captures everything a boilerplate forward needs — HTTP method, the upstream
    path (identical on both sides), the auth dependency, the timeout, whether to
    forward the request's JSON body, and the error label. Endpoints with real
    logic (audit logging, status fallback, path/query params, binary or
    streaming bodies) stay as explicit functions; only the pure forwards belong
    in a table.
    """

    method: str
    path: str
    auth: Callable
    timeout_s: float = 5.0
    forward_body: bool = False
    label: str = "Hardware"


def _proxy_endpoint_name(route: ProxyRoute) -> str:
    slug = "".join(c if c.isalnum() else "_" for c in route.path).strip("_")
    return f"proxy_{route.method.lower()}_{slug}"


def _make_proxy_endpoint(route: ProxyRoute):
    async def endpoint(request: Request) -> JSONResponse:
        body = None
        if route.forward_body:
            # Match the hand-written forwards: a missing/!JSON body becomes {}.
            try:
                body = await request.json()
            except Exception:
                body = {}
        return await proxy_json(
            route.method, request, route.path,
            json_body=body, timeout_s=route.timeout_s, label=route.label,
        )

    endpoint.__name__ = _proxy_endpoint_name(route)
    return endpoint


def register_proxy_routes(router: APIRouter, routes: "list[ProxyRoute]") -> None:
    """Register every :class:`ProxyRoute` as a pass-through endpoint on ``router``.

    Adding a forwarded endpoint is then a one-line table entry rather than a
    new function — and the method/path/auth/timeout are visible at a glance in
    one place instead of scattered across decorators.
    """
    for route in routes:
        router.add_api_route(
            route.path,
            _make_proxy_endpoint(route),
            methods=[route.method],
            dependencies=[Depends(route.auth)],
            name=_proxy_endpoint_name(route),
        )


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


async def _drain_until_disconnect(ws: WebSocket) -> None:
    """Block until the browser closes a send-only websocket.

    These bridge sockets only flow server→browser, so the browser never sends.
    The only thing a read yields is the disconnect (raised as an exception); a
    stray text/ping frame just loops. Racing this against frame delivery lets us
    notice a closed tab promptly instead of on the next publish — which, for a
    quiet stream, could be many seconds away.
    """
    while True:
        await ws.receive_text()


async def pump_bridge_to_websocket(ws: WebSocket, bridge, *, frame_name: str = "bridge-ws") -> None:
    """Fan a bridge's frames out to one browser WS until either side closes.

    Subscribes to ``bridge``, relays every published frame as JSON, and always
    unsubscribes on exit. Each frame wait is raced against a background read of
    the socket (:func:`_drain_until_disconnect`) so a browser disconnect is
    detected immediately rather than only when the next frame arrives. This is
    the single implementation shared by every ``/ws/*`` bridge route.
    """
    q = bridge.subscribe()
    disconnect_task = asyncio.create_task(
        _drain_until_disconnect(ws), name=f"{frame_name}-disconnect",
    )
    frame_task: asyncio.Task | None = None
    try:
        while True:
            frame_task = asyncio.create_task(q.get(), name=f"{frame_name}-frame")
            done, pending = await asyncio.wait(
                {frame_task, disconnect_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                try:
                    disconnect_task.result()
                except (WebSocketDisconnect, RuntimeError):
                    pass
                for task in pending:
                    task.cancel()
                break
            frame = frame_task.result()
            frame_task = None
            await ws.send_json(frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        if frame_task is not None and not frame_task.done():
            frame_task.cancel()
        if not disconnect_task.done():
            disconnect_task.cancel()
        bridge.unsubscribe(q)


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
    "ProxyRoute",
    "register_proxy_routes",
    "status_with_fallback",
    "binary_passthrough",
    "pump_bridge_to_websocket",
    "reject_unauthorized_ws",
)
