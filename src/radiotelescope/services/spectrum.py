"""Spectrum service.

Pulls IQ chunks from `SDRReceiver`, computes Hann-windowed FFTs, maintains a
rolling exponential-moving-average integration, and publishes frames to
subscribers over an asyncio.Queue (drop-oldest on full).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Iterable

import numpy as np

from radiotelescope.config import SDRConfig
from radiotelescope.hardware.sdr import SDRReceiver

logger = logging.getLogger(__name__)


class SpectrumFrame(dict):
    """Plain dict so FastAPI's WebSocket can JSON-encode it cheaply."""


class SpectrumService:
    def __init__(self, receiver: SDRReceiver, cfg: SDRConfig) -> None:
        self._rx = receiver
        self._cfg = cfg
        self._task: asyncio.Task | None = None
        self._subscribers: list[asyncio.Queue[SpectrumFrame]] = []
        self._latest: SpectrumFrame | None = None
        self._integrated: np.ndarray | None = None
        self._window = np.hanning(cfg.fft_size).astype(np.float32)
        self._freqs_mhz = self._build_freq_axis()

    def _build_freq_axis(self) -> np.ndarray:
        """FFT-shifted frequency axis in MHz, centred on `center_freq_hz`."""
        bin_hz = self._cfg.sample_rate_hz / self._cfg.fft_size
        # Standard centred axis: -N/2 .. N/2-1
        k = np.arange(self._cfg.fft_size, dtype=np.float64) - self._cfg.fft_size / 2.0
        return ((self._cfg.center_freq_hz + k * bin_hz) / 1e6).astype(np.float32)

    @property
    def mode(self) -> str:
        return self._rx.mode

    @property
    def latest(self) -> SpectrumFrame | None:
        return self._latest

    async def start(self) -> None:
        await self._rx.open()
        self._task = asyncio.create_task(self._run())
        logger.info("Spectrum service started (mode=%s)", self._rx.mode)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._rx.close()
        logger.info("Spectrum service stopped")

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[SpectrumFrame]:
        q: asyncio.Queue[SpectrumFrame] = asyncio.Queue(maxsize=maxsize)
        if self._latest is not None:
            q.put_nowait(self._latest)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[SpectrumFrame]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def _run(self) -> None:
        cfg = self._cfg
        alpha = 1.0 / cfg.integration_frames
        publish_interval = 1.0 / cfg.publish_rate_hz
        last_publish = 0.0
        try:
            async for iq in self._rx.stream():
                if iq.size < cfg.fft_size:
                    continue
                samples = iq[: cfg.fft_size]
                spectrum = np.fft.fftshift(np.fft.fft(samples * self._window))
                power = (spectrum.real ** 2 + spectrum.imag ** 2).astype(np.float32)
                # Avoid log(0); the FFT magnitudes never quite hit zero in practice
                # but a floor keeps the y-axis tidy when the gain is low.
                power = np.maximum(power, 1e-12)
                if self._integrated is None:
                    self._integrated = power
                else:
                    self._integrated = (1.0 - alpha) * self._integrated + alpha * power

                now = time.monotonic()
                if now - last_publish < publish_interval:
                    continue
                last_publish = now
                self._publish(self._integrated)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Spectrum loop crashed")

    def _publish(self, integrated: np.ndarray) -> None:
        # Convert to dB; subtract median so the trace floats around 0 dB and the
        # 1420 MHz line stands out without needing a calibrated reference.
        power_db = 10.0 * np.log10(integrated)
        power_db -= float(np.median(power_db))
        frame = SpectrumFrame(
            timestamp=time.time(),
            center_freq_mhz=self._cfg.center_freq_hz / 1e6,
            sample_rate_mhz=self._cfg.sample_rate_hz / 1e6,
            integration_frames=self._cfg.integration_frames,
            mode=self._rx.mode,
            freqs_mhz=self._freqs_mhz.tolist(),
            power_db=power_db.astype(np.float32).round(3).tolist(),
        )
        self._latest = frame
        for q in list(self._subscribers):
            _put_latest(q, frame)


def _put_latest(q: asyncio.Queue[SpectrumFrame], frame: SpectrumFrame) -> None:
    try:
        q.put_nowait(frame)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
        q.put_nowait(frame)


__all__: Iterable[str] = ("SpectrumService", "SpectrumFrame")
