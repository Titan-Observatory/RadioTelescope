from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)


class ClientAllowlistMiddleware:
    """LAN-only allowlist.

    Disabled by default when running behind a public reverse proxy: leaving the
    middleware in `block_unknown=False` mode means *every* IP is allowed
    through the middleware, and per-endpoint authorization is delegated to the
    queue/session layer (`require_control` + `is_lan_admin`). When
    `block_unknown=True` the middleware behaves like the old LAN-only gate.
    """

    def __init__(
        self,
        app: ASGIApp,
        allowed_clients: list[str],
        block_unknown: bool = False,
    ) -> None:
        self.app = app
        self.allowed_clients = set(allowed_clients)
        self.block_unknown = block_unknown

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"} or not self.block_unknown:
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        client_host = client[0] if client else None
        # Always allow loopback — blocking localhost is never intentional
        is_loopback = client_host in {"127.0.0.1", "::1"} or (
            client_host is not None and client_host.startswith("127.")
        )
        if is_loopback or client_host in self.allowed_clients:
            await self.app(scope, receive, send)
            return

        logger.warning("Rejected %s connection from %s", scope["type"], client_host or "unknown")
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": "Client IP not allowed"})
            return

        await self._send_http_forbidden(send)

    async def _send_http_forbidden(self, send: Send) -> None:
        body = b"Client IP not allowed"
        send_message: Callable[[Message], Awaitable[None]] = send
        await send_message(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send_message({"type": "http.response.body", "body": body})
