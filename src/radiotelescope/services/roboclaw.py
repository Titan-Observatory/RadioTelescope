from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from radiotelescope.hardware.roboclaw import RoboClawClient
from radiotelescope.models.state import RoboClawTelemetry

logger = logging.getLogger(__name__)


class RoboClawService:
    def __init__(self, client: RoboClawClient, update_rate_hz: int) -> None:
        self._client = client
        self._rate = update_rate_hz
        self._subscribers: list[asyncio.Queue[RoboClawTelemetry]] = []
        self._task: asyncio.Task | None = None
        self._latest: RoboClawTelemetry | None = None

    @property
    def client(self) -> RoboClawClient:
        return self._client

    @property
    def latest(self) -> RoboClawTelemetry:
        if self._latest is None:
            self._latest = self._client.snapshot()
        return self._latest

    async def start(self) -> None:
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("RoboClaw telemetry service started at %d Hz", self._rate)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._client.close()
        logger.info("RoboClaw telemetry service stopped")

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[RoboClawTelemetry]:
        q: asyncio.Queue[RoboClawTelemetry] = asyncio.Queue(maxsize=maxsize)
        if self._latest is not None:
            q.put_nowait(self._latest)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[RoboClawTelemetry]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def run_blocking(self, func: Callable[[], RoboClawTelemetry]) -> RoboClawTelemetry:
        return await asyncio.to_thread(func)

    async def _poll_loop(self) -> None:
        interval = 1.0 / self._rate
        while True:
            self._latest = await asyncio.to_thread(self._client.snapshot)
            for q in list(self._subscribers):
                _put_latest(q, self._latest)
            await asyncio.sleep(interval)


def _put_latest(q: asyncio.Queue[RoboClawTelemetry], state: RoboClawTelemetry) -> None:
    try:
        q.put_nowait(state)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
        q.put_nowait(state)
