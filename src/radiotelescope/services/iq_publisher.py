"""Pi-side fan-out of raw IQ samples to WebSocket subscribers.

In `gateway-server` mode the Pi does not compute spectra — it just forwards
raw `uint8` I/Q pairs over `/ws/iq` so the LAN host can run the FFT
pipeline. This service drives `SDRReceiver.stream_bytes()` (which gets the
data straight out of pyrtlsdr without a numpy round-trip) and fans the
chunks out to subscribers using drop-oldest on full queues.

The default subscriber queue is sized to absorb one USB transfer's worth of
chunks (pyrtlsdr typically delivers ~8 FFT-sized chunks per USB transfer at
2.4 Msps with `fft_size = 2048`) so transient backpressure doesn't silently
eat samples.
"""
from __future__ import annotations

import asyncio
import logging

from radiotelescope.hardware.sdr import SDRReceiver

logger = logging.getLogger(__name__)


class IQPublisher:
    def __init__(self, receiver: SDRReceiver) -> None:
        self._rx = receiver
        self._task: asyncio.Task | None = None
        self._subscribers: list[asyncio.Queue[bytes]] = []

    @property
    def mode(self) -> str:
        return self._rx.mode

    async def start(self) -> None:
        await self._rx.open()
        self._task = asyncio.create_task(self._run())
        logger.info("IQ publisher started (mode=%s)", self._rx.mode)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._rx.close()
        logger.info("IQ publisher stopped")

    def subscribe(self, maxsize: int = 32) -> asyncio.Queue[bytes]:
        q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[bytes]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def _run(self) -> None:
        try:
            async for payload in self._rx.stream_bytes():
                if not self._subscribers:
                    continue
                for q in list(self._subscribers):
                    _put_latest(q, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("IQ publisher loop crashed")


def _put_latest(q: asyncio.Queue[bytes], payload: bytes) -> None:
    try:
        q.put_nowait(payload)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
        q.put_nowait(payload)
