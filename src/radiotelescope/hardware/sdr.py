"""RTL-SDR hardware wrapper.

Wraps `pyrtlsdr.RtlSdrAio` for async sample streaming. If pyrtlsdr or a real
dongle is unavailable, the receiver enters `unavailable` mode and produces no
samples — downstream consumers see an empty stream and publish nothing,
rather than receiving synthetic data that would silently masquerade as live.
"""
from __future__ import annotations

import logging
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
    _RTLSDR_IMPORT_ERROR = str(exc)


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
            self.mode = "unavailable"
            logger.error(
                "pyrtlsdr is not importable (%s); SDR will produce no data. "
                "Install librtlsdr + pyrtlsdr to enable the spectrum pipeline.",
                _RTLSDR_IMPORT_ERROR,
            )
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
            self._sdr = None
            self.mode = "unavailable"
            logger.error(
                "RTL-SDR open failed (%s); SDR will produce no data. "
                "Check that the dongle is plugged in and not held by another process.",
                exc,
            )

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
        """Yield successive IQ chunks of length `fft_size` as complex64.

        When the SDR isn't available the generator returns immediately —
        SpectrumService's async-for exits cleanly and no frames are published.
        """
        if self.mode != "rtlsdr" or self._sdr is None:
            return
        n = self._cfg.fft_size
        async for samples in self._sdr.stream(num_samples_or_bytes=n, format="samples"):  # type: ignore[attr-defined]
            yield np.asarray(samples, dtype=np.complex64)

    async def stream_bytes(self) -> AsyncIterator[bytes]:
        """Yield raw uint8 I/Q chunks (2 × `fft_size` bytes each).

        Matches the RTL-SDR's native USB wire format. Returns immediately when
        the SDR isn't available — same contract as `stream()`.
        """
        if self.mode != "rtlsdr" or self._sdr is None:
            return
        n_bytes = 2 * self._cfg.fft_size
        async for buf in self._sdr.stream(num_samples_or_bytes=n_bytes, format="bytes"):  # type: ignore[attr-defined]
            # pyrtlsdr may hand back a bytes, bytearray, or numpy uint8 buffer
            # depending on version — coerce to immutable bytes so the publisher
            # can fan it out without copying per subscriber.
            yield bytes(buf) if not isinstance(buf, bytes) else buf
