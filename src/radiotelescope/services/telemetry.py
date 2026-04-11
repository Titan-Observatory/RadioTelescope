from __future__ import annotations

import asyncio
import logging
import time

from radiotelescope.hardware.current_sensor import INA226
from radiotelescope.models.state import TelescopeState
from radiotelescope.safety.interlocks import SafetyMonitor
from radiotelescope.services.motion import MotionService

logger = logging.getLogger(__name__)


class TelemetryService:
    def __init__(
        self,
        ina226: INA226,
        safety: SafetyMonitor,
        motion: MotionService,
        update_rate_hz: int = 10,
    ) -> None:
        self._ina226 = ina226
        self._safety = safety
        self._motion = motion
        self._rate = update_rate_hz
        self._subscribers: list[asyncio.Queue[TelescopeState]] = []
        self._task: asyncio.Task | None = None
        self._start_time = time.time()

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[TelescopeState]:
        q: asyncio.Queue[TelescopeState] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[TelescopeState]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def start(self) -> None:
        self._start_time = time.time()
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("Telemetry service started at %d Hz", self._rate)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Telemetry service stopped")

    async def _poll_loop(self) -> None:
        interval = 1.0 / self._rate
        motors = list(self._motion._motors.values())

        while True:
            reading = await asyncio.to_thread(self._ina226.read)

            if not self._safety.check_current(reading):
                self._safety.emergency_stop(motors)

            state = TelescopeState(
                motors=self._motion.get_state(),
                sensor=reading,
                safety=self._safety.status,
                uptime_s=round(time.time() - self._start_time, 1),
            )

            for q in list(self._subscribers):
                try:
                    q.put_nowait(state)
                except asyncio.QueueFull:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    q.put_nowait(state)

            await asyncio.sleep(interval)

    def latest_state(self) -> TelescopeState:
        reading = self._ina226.read()
        return TelescopeState(
            motors=self._motion.get_state(),
            sensor=reading,
            safety=self._safety.status,
            uptime_s=round(time.time() - self._start_time, 1),
        )
