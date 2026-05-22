"""HTTP client for the rt-hardware service.

Used by the platform's motor/camera/spectrum proxy routes. We don't model
the hardware responses here — they're forwarded verbatim to the browser,
which already knows the schema from `types.gen.ts`.
"""
from __future__ import annotations

import httpx


class HardwareClient:
    """Thin async httpx wrapper bound to the hardware service base URL."""

    def __init__(self, base_url: str, timeout_s: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout_s
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self._timeout)

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("HardwareClient is not started")
        return self._client

    @property
    def ws_base_url(self) -> str:
        if self.base_url.startswith("http://"):
            return "ws://" + self.base_url[len("http://"):]
        if self.base_url.startswith("https://"):
            return "wss://" + self.base_url[len("https://"):]
        return self.base_url
