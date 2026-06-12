"""Synthetic GOES downlink for development and demos (``goes.simulate = true``).

Produces the same two artefacts the GNU Radio subprocess would: demod
metrics dicts and a CADU *bitstream* — the service then runs its real decode
chain (deframer → RS → LRIT → products) against the synthetic stream, so
simulate mode exercises every line of the production path except the DSP.

Acquisition follows the dish: when a pointing-error callback is available the
SNR climbs as the dish closes on the target satellite (scaled by the beam
width), exactly the feedback loop a real operator uses to peak the signal.
Without motor telemetry it converges on a timer so the UI is still demoable.
"""
from __future__ import annotations

import math
import random
import time
from typing import Callable

import numpy as np

from rt_hardware.config import GoesConfig
from rt_hardware.goes.encode import encode_file_to_cadus
from rt_hardware.goes.lrit import FILE_TYPE_IMAGE, FILE_TYPE_TEXT

# Peak SNR when the dish is dead-centre on the satellite, and the noise-only
# floor reported far off target.
_SNR_PEAK_DB = 14.5
_SNR_FLOOR_DB = 0.4
_PRODUCT_INTERVAL_S = 12.0
_IMAGE_SIZE = 480

_BULLETINS = (
    "GOES DCS ADMIN MESSAGE\nDCPI channel assignments nominal.\nNo outages scheduled.",
    "NWS MARINE FORECAST\nSynopsis: high pressure ridge persists offshore.\nSeas 1 to 2 ft.",
    "GOES HRIT SERVICE NOTICE\nAll virtual channels operating normally.\nNext ABI full disk in 10 min.",
    "SPACE WEATHER SUMMARY\nSolar activity low. Geomagnetic field quiet.\nNo radio blackouts observed.",
)


class GoesSimulator:
    def __init__(
        self,
        cfg: GoesConfig,
        pointing_error_deg: Callable[[], float | None] | None = None,
        beam_fwhm_deg: float = 1.2,
    ) -> None:
        self._cfg = cfg
        self._pointing_error_deg = pointing_error_deg
        self._beam = max(0.2, beam_fwhm_deg)
        self._started = time.monotonic()
        self._snr_db = _SNR_FLOOR_DB
        self._freq_offset_hz = random.uniform(-12_000, 12_000)
        self._next_product_at = 0.0
        self._image_counter = 0
        self._text_counter = 0

    # ── Acquisition model ─────────────────────────────────────────────

    def _target_snr(self) -> float:
        error = self._pointing_error_deg() if self._pointing_error_deg else None
        if error is None:
            # No motor telemetry: converge over ~20 s so the demo still works.
            progress = min(1.0, (time.monotonic() - self._started) / 20.0)
            error = (1.0 - progress) * 2.0 * self._beam
        # Gaussian beam rolloff: -12 dB at one FWHM off boresight.
        rolloff_db = 12.0 * (error / self._beam) ** 2
        return max(_SNR_FLOOR_DB, _SNR_PEAK_DB - rolloff_db)

    @property
    def locked(self) -> bool:
        return self._snr_db >= self._cfg.snr_lock_db

    # ── Pipeline-shaped outputs ───────────────────────────────────────

    def metrics(self) -> dict:
        # First-order chase of the target SNR + measurement jitter, so the
        # readout breathes like a real estimator instead of snapping.
        self._snr_db += 0.35 * (self._target_snr() - self._snr_db)
        snr = self._snr_db + random.gauss(0, 0.15)
        # Carrier offset pulls toward a small residual once the loop has signal.
        self._freq_offset_hz += 0.2 * ((random.gauss(0, 30) if self.locked else random.gauss(0, 2500)) - self._freq_offset_hz)
        return {
            "timestamp": time.time(),
            "snr_db": round(snr, 2),
            "freq_offset_hz": round(self._freq_offset_hz, 1),
            "constellation": self._constellation(snr),
            "psd_db": self._psd(snr),
        }

    def _constellation(self, snr_db: float) -> list[list[float]]:
        n = 96
        noise = 10 ** (-snr_db / 20.0)
        symbols = np.random.choice((-1.0, 1.0), n)
        i = symbols + np.random.normal(0, noise, n)
        q = np.random.normal(0, noise, n)
        return [[round(float(a), 4), round(float(b), 4)] for a, b in zip(i, q)]

    def _psd(self, snr_db: float) -> list[float]:
        bins = 256
        freqs = np.linspace(-0.5, 0.5, bins)
        floor = -71.0 + np.random.normal(0, 0.5, bins)
        # HRIT signal occupies ~1.2 MHz of the 3 MHz span → ±0.2 in fractional bins.
        width = 0.62 * self._cfg.symbol_rate_baud / self._cfg.sample_rate_hz
        hump = np.clip(snr_db, 0, None) * 0.85 * (1.0 / (1.0 + np.exp((np.abs(freqs) - width) * 120.0)))
        return np.round(floor + hump, 2).tolist()

    def data_chunk(self) -> bytes:
        """Bitstream bytes for one status tick: CADUs when locked, noise otherwise."""
        if not self.locked:
            return random.randbytes(512)
        now = time.monotonic()
        if now < self._next_product_at:
            return b""
        self._next_product_at = now + _PRODUCT_INTERVAL_S
        if (self._image_counter + self._text_counter) % 3 == 2:
            return self._text_product()
        return self._image_product()

    # ── Synthetic products ────────────────────────────────────────────

    def _text_product(self) -> bytes:
        self._text_counter += 1
        body = _BULLETINS[self._text_counter % len(_BULLETINS)]
        text = f"{body}\n\nIssued: {time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime())}\n".encode()
        return encode_file_to_cadus(
            0, 100 + (self._text_counter % 4), FILE_TYPE_TEXT, text,
            annotation=f"A_ADMIN_SIM_{self._text_counter:04d}.lrit",
        )

    def _image_product(self) -> bytes:
        self._image_counter += 1
        pixels = _render_disk(_IMAGE_SIZE, self._image_counter)
        return encode_file_to_cadus(
            1 + (self._image_counter % 2), 200 + (self._image_counter % 2),
            FILE_TYPE_IMAGE, pixels.tobytes(),
            annotation=f"OR_ABI_SIM_FD_{self._image_counter:04d}.lrit",
            columns=_IMAGE_SIZE, lines=_IMAGE_SIZE,
        )


def _render_disk(size: int, seed: int) -> np.ndarray:
    """A plausible-looking 8-bit 'full disk': limb-darkened sphere + cloud bands."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size]
    cx = cy = size / 2.0
    radius = size * 0.46
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius
    disk = np.clip(1.0 - r**2, 0.0, 1.0) ** 0.5
    lat = (y - cy) / radius
    bands = 0.22 * np.sin(lat * (6.0 + (seed % 3)) + seed) + 0.12 * np.sin(lat * 13.0 - seed)
    clouds = rng.normal(0, 0.05, (size, size))
    # Smooth the noise into blobs with a cheap separable box blur.
    for axis in (0, 1):
        clouds = (np.roll(clouds, 3, axis) + np.roll(clouds, -3, axis) + clouds) / 3.0
    image = (disk * (0.55 + bands + clouds * 3.0)).clip(0, 1)
    image[r > 1.0] = 0.02 + 0.01 * rng.random(int((r > 1.0).sum()))
    return (image * 255).astype(np.uint8)


__all__ = ("GoesSimulator",)
