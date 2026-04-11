from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator

import numpy as np
from rtlsdr import RtlSdrAio

from radiotelescope.config import SDRConfig

logger = logging.getLogger(__name__)


class SDRReceiver:
    """Async wrapper around pyrtlsdr for streaming IQ samples."""

    def __init__(self, config: SDRConfig) -> None:
        self._cfg = config
        self._sdr: RtlSdrAio | None = None

    async def open(self) -> None:
        sdr = RtlSdrAio(device_index=self._cfg.device_index)
        sdr.sample_rate = self._cfg.sample_rate_hz
        sdr.center_freq = self._cfg.center_freq_hz
        if self._cfg.gain == "auto":
            sdr.gain = "auto"
        else:
            sdr.gain = float(self._cfg.gain)
        self._sdr = sdr
        logger.info(
            "SDR opened: %.3f MHz, %d sps, gain=%s",
            self._cfg.center_freq_hz / 1e6,
            self._cfg.sample_rate_hz,
            self._cfg.gain,
        )

    async def stream_samples(self, num_samples: int = 0) -> AsyncGenerator[np.ndarray]:
        if self._sdr is None:
            raise RuntimeError("SDR not opened — call open() first")
        if num_samples <= 0:
            num_samples = self._cfg.fft_size * self._cfg.integration_count

        while True:
            samples = await asyncio.to_thread(self._sdr.read_samples, num_samples)
            yield np.asarray(samples)

    async def tune(self, freq: int | None = None, gain: str | float | None = None) -> None:
        if self._sdr is None:
            return
        if freq is not None:
            self._sdr.center_freq = freq
            logger.info("SDR tuned to %.3f MHz", freq / 1e6)
        if gain is not None:
            self._sdr.gain = "auto" if gain == "auto" else float(gain)

    async def close(self) -> None:
        if self._sdr is not None:
            await asyncio.to_thread(self._sdr.close)
            self._sdr = None
