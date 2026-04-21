from __future__ import annotations

import asyncio
import logging
import secrets
import time

from fastapi import HTTPException, Request

from radiotelescope.models.state import SessionStatus

logger = logging.getLogger(__name__)

_INACTIVITY_TIMEOUT_S = 60.0
_CHECK_INTERVAL_S = 5.0


class SessionService:
    def __init__(self) -> None:
        self._token: str | None = None
        self._client_id: str | None = None
        self._claimed_at: float | None = None
        self._expires_at: float | None = None
        self._task: asyncio.Task | None = None

    def claim(self, client_id: str) -> str:
        if self._token is not None:
            raise HTTPException(status_code=409, detail="Session already claimed by another user")
        self._token = secrets.token_hex(16)
        self._client_id = client_id
        self._claimed_at = time.time()
        self._expires_at = self._claimed_at + _INACTIVITY_TIMEOUT_S
        logger.info("Session claimed by %s", client_id)
        return self._token

    def release(self, token: str) -> None:
        if token != self._token:
            raise HTTPException(status_code=403, detail="Invalid session token")
        self._clear()
        logger.info("Session released")

    def heartbeat(self, token: str) -> None:
        if token == self._token:
            self._expires_at = time.time() + _INACTIVITY_TIMEOUT_S

    def verify(self, token: str) -> bool:
        return token == self._token

    def get_status(self) -> SessionStatus:
        return SessionStatus(
            active=self._token is not None,
            client_id=self._client_id,
            claimed_at=self._claimed_at,
            expires_at=self._expires_at,
        )

    async def start(self) -> None:
        self._task = asyncio.create_task(self._expire_loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def _clear(self) -> None:
        self._token = None
        self._client_id = None
        self._claimed_at = None
        self._expires_at = None

    async def _expire_loop(self) -> None:
        while True:
            await asyncio.sleep(_CHECK_INTERVAL_S)
            if self._expires_at is not None and time.time() > self._expires_at:
                logger.info("Session expired due to inactivity (client: %s)", self._client_id)
                self._clear()


def require_session(request: Request) -> None:
    token = request.headers.get("X-Session-Token", "")
    svc: SessionService = request.app.state.session_service
    if not svc.verify(token):
        raise HTTPException(status_code=403, detail="Valid session token required")
