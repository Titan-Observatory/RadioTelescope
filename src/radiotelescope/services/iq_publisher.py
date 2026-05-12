"""Pi-side fan-out of raw IQ samples to WebSocket subscribers.

In `gateway-server` mode the Pi does not compute spectra — it just forwards
raw `uint8` I/Q pairs over `/ws/iq` so the LAN host can run the FFT
pipeline. This service mirrors the pub/sub shape of `SpectrumService`:
drives `SDRReceiver.stream()` once, broadcasts each chunk to N subscribers,
drop-oldest on full queue.
"""
from __future__ import annotations

import asyncio
import logging

import numpy as np

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

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[bytes]:
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
            async for iq in self._rx.stream():
                if not self._subscribers:
                    continue
                payload = _complex_to_uint8_iq(iq)
                for q in list(self._subscribers):
                    _put_latest(q, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("IQ publisher loop crashed")


def _complex_to_uint8_iq(samples: np.ndarray) -> bytes:
    """Inverse of `_bytes_to_complex64` in hardware/remote.py.

    Re-encodes centred complex64 samples back to RTL-SDR-native uint8 I/Q so
    the wire format matches what the dongle would have produced. Clipping
    keeps strong signals from wrapping around.
    """
    real = np.clip(samples.real * 127.5 + 127.5, 0.0, 255.0)
    imag = np.clip(samples.imag * 127.5 + 127.5, 0.0, 255.0)
    interleaved = np.empty(samples.size * 2, dtype=np.uint8)
    interleaved[0::2] = real.astype(np.uint8)
    interleaved[1::2] = imag.astype(np.uint8)
    return interleaved.tobytes()


def _put_latest(q: asyncio.Queue[bytes], payload: bytes) -> None:
    try:
        q.put_nowait(payload)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
        q.put_nowait(payload)
