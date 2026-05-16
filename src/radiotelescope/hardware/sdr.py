"""Airspy SDR hardware wrapper.

Talks to an Airspy Mini (or R2) via SoapySDR's ``airspy`` module. If
SoapySDR or a real dongle is unavailable the receiver enters ``unavailable``
mode and produces no samples — downstream consumers see an empty stream and
publish nothing, rather than receiving synthetic data that would silently
masquerade as live.

Streaming is bridged from SoapySDR's blocking ``readStream`` onto asyncio
via ``asyncio.to_thread`` so the rest of the app can ``async for`` over it.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

import numpy as np

from radiotelescope.config import SDRConfig

logger = logging.getLogger(__name__)

try:
    import SoapySDR  # type: ignore
    from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32  # type: ignore
    _SOAPY_AVAILABLE = True
except Exception as exc:  # pragma: no cover — exercised on non-Pi hosts
    SoapySDR = None  # type: ignore
    SOAPY_SDR_RX = 0  # type: ignore
    SOAPY_SDR_CF32 = "CF32"  # type: ignore
    _SOAPY_AVAILABLE = False
    _SOAPY_IMPORT_ERROR = str(exc)


# Airspy Mini supports 3 Msps and 6 Msps only. Airspy R2 adds 2.5 / 10 Msps.
_AIRSPY_RATES = (2_500_000.0, 3_000_000.0, 6_000_000.0, 10_000_000.0)


class SDRReceiver:
    """Async source of complex IQ sample chunks of length ``fft_size``."""

    def __init__(self, cfg: SDRConfig) -> None:
        self._cfg = cfg
        self._sdr: object | None = None
        self._stream: object | None = None
        self.mode: str = "uninitialised"

    @property
    def config(self) -> SDRConfig:
        return self._cfg

    async def open(self) -> None:
        if not self._cfg.enabled:
            self.mode = "disabled"
            return
        if not _SOAPY_AVAILABLE:
            self.mode = "unavailable"
            logger.error(
                "SoapySDR is not importable (%s); SDR will produce no data. "
                "Install soapysdr-module-airspy + python3-soapysdr to enable "
                "the spectrum pipeline.",
                _SOAPY_IMPORT_ERROR,
            )
            return
        try:
            # String form ("driver=airspy") rather than dict — the SWIG
            # dict→Kwargs conversion is broken in some 0.8.x builds and
            # silently raises `Device::make() no match`.
            sdr = SoapySDR.Device("driver=airspy")  # type: ignore[union-attr]
            sdr.setSampleRate(SOAPY_SDR_RX, 0, float(self._cfg.sample_rate_hz))
            sdr.setFrequency(SOAPY_SDR_RX, 0, float(self._cfg.center_freq_hz))
            if self._cfg.gain_db is None:
                sdr.setGainMode(SOAPY_SDR_RX, 0, True)  # AGC
            else:
                sdr.setGainMode(SOAPY_SDR_RX, 0, False)
                # Airspy's "overall" gain is a 0-21 linearity index, not dB.
                # We pass the configured value straight through and clamp.
                g = max(0.0, min(21.0, float(self._cfg.gain_db)))
                sdr.setGain(SOAPY_SDR_RX, 0, g)
            stream = sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
            sdr.activateStream(stream)
            self._sdr = sdr
            self._stream = stream
            self.mode = "airspy"
            logger.info(
                "Airspy opened at %.3f MHz, %.1f Msps",
                self._cfg.center_freq_hz / 1e6,
                self._cfg.sample_rate_hz / 1e6,
            )
        except Exception as exc:
            self._sdr = None
            self._stream = None
            self.mode = "unavailable"
            logger.error(
                "Airspy open failed (%s); SDR will produce no data. "
                "Check that the dongle is plugged in and not held by another process.",
                exc,
            )

    async def close(self) -> None:
        sdr, stream = self._sdr, self._stream
        self._sdr = None
        self._stream = None
        if sdr is None or stream is None:
            return
        try:
            sdr.deactivateStream(stream)  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            sdr.closeStream(stream)  # type: ignore[attr-defined]
        except Exception:
            pass

    def _read_chunk(self, buf: np.ndarray) -> int:
        """Blocking single read into ``buf``. Returns samples read (>=0) or <0 on error."""
        sr = self._sdr.readStream(  # type: ignore[union-attr]
            self._stream, [buf], buf.size, timeoutUs=1_000_000
        )
        return int(sr.ret)

    async def stream(self) -> AsyncIterator[np.ndarray]:
        """Yield successive IQ chunks of length ``fft_size`` as complex64."""
        if self.mode != "airspy" or self._sdr is None or self._stream is None:
            return
        n = self._cfg.fft_size
        while True:
            buf = np.empty(n, dtype=np.complex64)
            got = 0
            while got < n:
                read = await asyncio.to_thread(self._read_chunk, buf[got:])
                if read < 0:
                    logger.warning("Airspy readStream error: %d", read)
                    return
                got += read
            yield buf

    async def stream_bytes(self) -> AsyncIterator[bytes]:
        """Yield raw complex64 I/Q chunks (8 × ``fft_size`` bytes each).

        This is the gateway-server wire format consumed by
        :class:`radiotelescope.hardware.remote.RemoteSDRReceiver`.
        """
        async for buf in self.stream():
            yield buf.tobytes()
