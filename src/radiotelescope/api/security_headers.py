"""ASGI middleware that injects security headers on every HTTP response."""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

_HEADERS: list[tuple[bytes, bytes]] = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
    (
        b"content-security-policy",
        # default-src 'self'   — only same-origin resources by default
        # style-src unsafe-inline — needed for the inline <style> on the login page
        # img-src data: blob: https: — Aladin sky map tiles + data URIs
        # connect-src ws: wss:  — WebSocket telemetry streams
        # frame-ancestors 'none' — disallow embedding in iframes (clickjacking)
        # form-action 'self'    — forms may only POST to same origin
        b"default-src 'self'; "
        b"style-src 'self' 'unsafe-inline'; "
        b"img-src 'self' data: blob: https:; "
        b"connect-src 'self' ws: wss:; "
        b"frame-ancestors 'none'; "
        b"form-action 'self'",
    ),
]


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = list(message.get("headers", []))
                message = {**message, "headers": existing + _HEADERS}
            await send(message)

        await self.app(scope, receive, send_with_headers)
