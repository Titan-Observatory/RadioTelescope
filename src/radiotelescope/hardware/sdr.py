"""RTL-SDR hardware wrapper.

Wraps `pyrtlsdr.RtlSdrAio` for async sample streaming. If pyrtlsdr or a real
dongle is unavailable (Windows dev box, CI), falls back to a synthetic
generator so the rest of the stack can be exercised end-to-end.
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
from typing import AsyncIterator

import numpy as np

from radiotelescope.config import SDRConfig

logger = logging.getLogger(__name__)

try:
    from rtlsdr import RtlSdrAio  # type: ignore
    _RTLSDR_AVAILABLE = True
except Exception as exc:  # pragma: no cover — exercised on non-Pi hosts
    RtlSdrAio = None  # type: ignore
    _RTLSDR_AVAILABLE = False
    logger.info("pyrtlsdr unavailable (%s); SDR will run in simulated mode", exc)


class SDRReceiver:
    """Async source of complex IQ sample chunks of length `fft_size`."""

    def __init__(self, cfg: SDRConfig) -> None:
        self._cfg = cfg
        self._sdr: object | None = None
        self.mode: str = "uninitialised"

    @property
    def config(self) -> SDRConfig:
        return self._cfg

    async def open(self) -> None:
        if not self._cfg.enabled:
            self.mode = "disabled"
            return
        if not _RTLSDR_AVAILABLE:
            self.mode = "simulated"
            return
        try:
            sdr = RtlSdrAio()  # type: ignore[operator]
            sdr.sample_rate = self._cfg.sample_rate_hz
            sdr.center_freq = self._cfg.center_freq_hz
            if self._cfg.gain_db is None:
                sdr.gain = "auto"
            else:
                sdr.gain = self._cfg.gain_db
            self._sdr = sdr
            self.mode = "rtlsdr"
            logger.info(
                "RTL-SDR opened at %.3f MHz, %.1f Msps",
                self._cfg.center_freq_hz / 1e6,
                self._cfg.sample_rate_hz / 1e6,
            )
        except Exception as exc:
            logger.warning("RTL-SDR open failed (%s); falling back to simulated", exc)
            self._sdr = None
            self.mode = "simulated"

    async def close(self) -> None:
        sdr = self._sdr
        self._sdr = None
        if sdr is None:
            return
        try:
            await sdr.stop()  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            sdr.close()  # type: ignore[attr-defined]
        except Exception:
            pass

    async def stream(self) -> AsyncIterator[np.ndarray]:
        """Yield successive IQ chunks of length `fft_size`."""
        n = self._cfg.fft_size
        if self.mode == "rtlsdr" and self._sdr is not None:
            async for samples in self._sdr.stream(num_samples_or_bytes=n, format="samples"):  # type: ignore[attr-defined]
                yield np.asarray(samples, dtype=np.complex64)
        else:
            async for chunk in _simulated_stream(self._cfg):
                yield chunk


async def _simulated_stream(cfg: SDRConfig) -> AsyncIterator[np.ndarray]:
    """Synthesise IQ that looks plausible: white Gaussian noise plus a faint
    bump near 1420.4 MHz so the integrated spectrum has something to show."""
    n = cfg.fft_size
    rate = cfg.sample_rate_hz
    line_offset_hz = 1.4204058e9 - cfg.center_freq_hz
    # Frequency bin for the synthetic spectral line, relative to baseband.
    t = np.arange(n, dtype=np.float32) / rate
    phase = 0.0
    # Approximate one chunk per sample-window so loop pace matches real SDR.
    chunk_dt = n / rate
    while True:
        noise = (np.random.standard_normal(n) + 1j * np.random.standard_normal(n)).astype(np.complex64) * 0.05
        amp = 0.02 * (1.0 + 0.1 * math.sin(phase * 0.7))
        tone = amp * np.exp(2j * np.pi * line_offset_hz * t + 1j * phase).astype(np.complex64)
        # A bit of slow wander so the rolling integration has texture.
        phase += random.uniform(0.05, 0.15)
        yield noise + tone
        await asyncio.sleep(chunk_dt)
