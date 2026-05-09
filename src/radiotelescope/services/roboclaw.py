from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable

import katpoint

from radiotelescope.config import MountConfig
from radiotelescope.hardware.roboclaw import RoboClawClient
from radiotelescope.models.state import PollStats, RoboClawTelemetry
from radiotelescope.pointing import altaz_to_radec
from radiotelescope.services.geometry import encoder_counts_to_altitude

logger = logging.getLogger(__name__)


class RoboClawService:
    def __init__(
        self,
        client: RoboClawClient,
        update_rate_hz: int,
        mount_cfg: MountConfig | None = None,
        antenna: katpoint.Antenna | None = None,
    ) -> None:
        self._client = client
        self._rate = update_rate_hz
        self._mount_cfg = mount_cfg
        self._antenna = antenna
        self._subscribers: list[asyncio.Queue[RoboClawTelemetry]] = []
        self._task: asyncio.Task | None = None
        self._latest: RoboClawTelemetry | None = None
        self._tick_times: deque[float] = deque(maxlen=20)

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

    def _poll_stats(self) -> PollStats:
        now = time.monotonic()
        actual_hz: float | None = None
        last_age: float | None = None
        if len(self._tick_times) >= 2:
            span = self._tick_times[-1] - self._tick_times[0]
            if span > 0:
                actual_hz = (len(self._tick_times) - 1) / span
        if self._tick_times:
            last_age = max(0.0, now - self._tick_times[-1])
        return PollStats(target_hz=float(self._rate), actual_hz=actual_hz, last_tick_age_s=last_age)

    async def refresh(self) -> RoboClawTelemetry:
        """Take a fresh hardware snapshot, update cached state, and notify subscribers."""
        snap = await asyncio.to_thread(self._client.snapshot)
        self._tick_times.append(time.monotonic())
        updates: dict = {"poll": self._poll_stats()}

        if self._mount_cfg is not None:
            m1 = snap.motors.get("m1")
            m2 = snap.motors.get("m2")
            cfg = self._mount_cfg
            az = (
                (m1.encoder - cfg.az_zero_count) / cfg.az_counts_per_degree
                if m1 and m1.encoder is not None
                else None
            )
            alt = (
                encoder_counts_to_altitude(m2.encoder, cfg)
                if m2 and m2.encoder is not None
                else None
            )
            updates["azimuth_deg"] = az
            updates["altitude_deg"] = alt

            if self._antenna is not None and alt is not None and az is not None:
                try:
                    ra, dec = altaz_to_radec(alt, az, self._antenna)
                    updates["ra_deg"] = ra
                    updates["dec_deg"] = dec
                except Exception:
                    logger.debug("altaz_to_radec failed", exc_info=True)

        self._latest = snap.model_copy(update=updates) if updates else snap
        for q in list(self._subscribers):
            _put_latest(q, self._latest)
        return self._latest

    async def _poll_loop(self) -> None:
        interval = 1.0 / self._rate
        while True:
            await self.refresh()
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
