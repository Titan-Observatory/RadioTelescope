from __future__ import annotations

import asyncio
import base64
import logging
import time

import numpy as np
from pydantic import BaseModel

from radiotelescope.config import SDRConfig
from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.models.commands import SDRTuneCommand

logger = logging.getLogger(__name__)


class SpectrumFrame(BaseModel):
    center_freq_hz: int
    bandwidth_hz: int
    fft_size: int
    magnitudes_b64: str
    timestamp: float


class SpectrumService:
    def __init__(self, sdr: SDRReceiver, config: SDRConfig) -> None:
        self._sdr = sdr
        self._cfg = config
        self._subscribers: list[asyncio.Queue[SpectrumFrame]] = []
        self._task: asyncio.Task | None = None

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[SpectrumFrame]:
        q: asyncio.Queue[SpectrumFrame] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[SpectrumFrame]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def start(self) -> None:
        await self._sdr.open()
        self._task = asyncio.create_task(self._stream_loop())
        logger.info("Spectrum service started")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._sdr.close()
        logger.info("Spectrum service stopped")

    async def tune(self, cmd: SDRTuneCommand) -> None:
        await self._sdr.tune(freq=cmd.center_freq_hz, gain=cmd.gain)
        if cmd.center_freq_hz is not None:
            self._cfg.center_freq_hz = cmd.center_freq_hz
        if cmd.sample_rate_hz is not None:
            self._cfg.sample_rate_hz = cmd.sample_rate_hz

    async def _stream_loop(self) -> None:
        fft_size = self._cfg.fft_size
        n_avg = self._cfg.integration_count
        window = np.hanning(fft_size)

        async for samples in self._sdr.stream_samples(fft_size * n_avg):
            acc = np.zeros(fft_size)
            for i in range(n_avg):
                chunk = samples[i * fft_size : (i + 1) * fft_size]
                if len(chunk) < fft_size:
                    break
                spectrum = np.fft.fftshift(np.fft.fft(chunk * window))
                acc += np.abs(spectrum) ** 2

            psd_db = 10.0 * np.log10(acc / n_avg + 1e-12)
            magnitudes_bytes = psd_db.astype(np.float32).tobytes()

            frame = SpectrumFrame(
                center_freq_hz=self._cfg.center_freq_hz,
                bandwidth_hz=self._cfg.sample_rate_hz,
                fft_size=fft_size,
                magnitudes_b64=base64.b64encode(magnitudes_bytes).decode(),
                timestamp=time.time(),
            )

            for q in list(self._subscribers):
                try:
                    q.put_nowait(frame)
                except asyncio.QueueFull:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    q.put_nowait(frame)
