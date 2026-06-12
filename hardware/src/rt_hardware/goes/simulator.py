"""Synthetic GOES downlink for development and demos (``goes.simulate = true``).

Stands in for the goesrecv + goesproc subprocesses: each tick produces the
same observations the real nanomsg consumers would hand the service —
demodulator stats, per-frame decoder stats, a post-clock-recovery symbol
batch, VCDU headers — and, once locked, writes demo product files into the
product directory exactly where goesproc would. Everything downstream
(aggregation, status frames, product indexing, the entire frontend) runs
unchanged.

Acquisition follows the dish: when a pointing-error callback is available
the SNR climbs as the dish closes on the target satellite (scaled by the
beam width) — the same peak-the-meter loop a real operator uses. Without
motor telemetry it converges on a timer so the UI is still demoable.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from rt_hardware.config import GoesConfig

# Es/N0 when the dish is dead-centre on the satellite, and roughly what a
# noise-only constellation estimates to.
_SNR_PEAK_DB = 14.5
_PRODUCT_INTERVAL_S = 12.0
_IMAGE_SIZE = 480
_SYMBOLS_PER_TICK = 128

_BULLETINS = (
    "GOES DCS ADMIN MESSAGE\nDCPI channel assignments nominal.\nNo outages scheduled.",
    "NWS MARINE FORECAST\nSynopsis: high pressure ridge persists offshore.\nSeas 1 to 2 ft.",
    "GOES HRIT SERVICE NOTICE\nAll virtual channels operating normally.\nNext ABI full disk in 10 min.",
    "SPACE WEATHER SUMMARY\nSolar activity low. Geomagnetic field quiet.\nNo radio blackouts observed.",
)


@dataclass
class SimTick:
    """One status-rate tick of synthetic pipeline output (goesrecv shapes)."""
    demod_stats: dict
    decoder_stats: list[dict]
    symbols: list[tuple[float, float]] = field(default_factory=list)
    vcids: list[int] = field(default_factory=list)


class GoesSimulator:
    def __init__(
        self,
        cfg: GoesConfig,
        products_dir: Path,
        pointing_error_deg: Callable[[], float | None] | None = None,
        beam_fwhm_deg: float = 1.2,
    ) -> None:
        self._cfg = cfg
        self._products_dir = products_dir
        self._pointing_error_deg = pointing_error_deg
        self._beam = max(0.2, beam_fwhm_deg)
        self._started = time.monotonic()
        self._snr_db = 0.0
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
        return _SNR_PEAK_DB - rolloff_db

    @property
    def locked(self) -> bool:
        return self._snr_db >= self._cfg.snr_lock_db

    # ── Tick ──────────────────────────────────────────────────────────

    def tick(self) -> SimTick:
        # First-order chase of the target SNR so the meter breathes like a
        # real estimator instead of snapping.
        self._snr_db += 0.35 * (self._target_snr() - self._snr_db)
        # Carrier offset pulls toward a small residual once the loop has signal.
        wander = random.gauss(0, 30) if self.locked else random.gauss(0, 2500)
        self._freq_offset_hz += 0.2 * (wander - self._freq_offset_hz)

        demod_stats = {
            "gain": round(30.0 - self._snr_db, 2),
            "frequency": round(self._freq_offset_hz, 1),
            "omega": round(self._cfg.sample_rate_hz / self._cfg.symbol_rate_baud + random.gauss(0, 1e-4), 5),
        }

        decoder_stats: list[dict] = []
        vcids: list[int] = []
        if self.locked:
            # HRIT runs ~115 frames/s; emit a status-tick's worth, with
            # Viterbi corrections scaling against signal quality.
            frames = max(1, round(115.0 / self._cfg.status_rate_hz))
            quality = min(1.0, max(0.0, (self._snr_db - self._cfg.snr_lock_db) / 8.0))
            for _ in range(frames):
                viterbi = max(0, int(random.gauss(220 * (1.0 - quality), 30)))
                ok = viterbi < 400
                decoder_stats.append({
                    "skipped_symbols": 0,
                    "viterbi_errors": viterbi,
                    "reed_solomon_errors": 0 if quality > 0.6 else random.randrange(0, 4),
                    "ok": 1 if ok else 0,
                })
                if ok:
                    vcids.append(random.choice((0, 1, 1, 2, 2, 2, 20, 63)))
            self._write_products_if_due()

        return SimTick(
            demod_stats=demod_stats,
            decoder_stats=decoder_stats,
            symbols=self._symbols(self._snr_db),
            vcids=vcids,
        )

    def _symbols(self, snr_db: float) -> list[tuple[float, float]]:
        """Post-clock-recovery BPSK symbols at the estimator's SNR."""
        snr_lin = 10 ** (snr_db / 10.0)
        sigma = math.sqrt(1.0 / (2.0 * max(snr_lin, 1e-3)))
        bits = np.random.choice((-1.0, 1.0), _SYMBOLS_PER_TICK)
        i = bits + np.random.normal(0, sigma, _SYMBOLS_PER_TICK)
        q = np.random.normal(0, sigma, _SYMBOLS_PER_TICK)
        return [(round(float(a), 4), round(float(b), 4)) for a, b in zip(i, q)]

    # ── Demo products (written where goesproc would write) ───────────

    def _write_products_if_due(self) -> None:
        now = time.monotonic()
        if now < self._next_product_at:
            return
        self._next_product_at = now + _PRODUCT_INTERVAL_S
        try:
            if (self._image_counter + self._text_counter) % 3 == 2:
                self._write_text()
            else:
                self._write_image()
        except Exception:
            # Demo content only — never let it take the status loop down.
            pass

    def _write_text(self) -> None:
        self._text_counter += 1
        directory = self._products_dir / "text" / time.strftime("%Y-%m-%d")
        directory.mkdir(parents=True, exist_ok=True)
        body = _BULLETINS[self._text_counter % len(_BULLETINS)]
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        (directory / f"{stamp}_ADMIN_SIM_{self._text_counter:04d}.txt").write_text(
            f"{body}\n\nIssued: {stamp}\n",
        )

    def _write_image(self) -> None:
        import cv2

        self._image_counter += 1
        directory = self._products_dir / "images" / "goes19" / time.strftime("%Y-%m-%d")
        directory.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        pixels = _render_disk(_IMAGE_SIZE, self._image_counter)
        cv2.imwrite(str(directory / f"GOES19_FD_SIM_{stamp}_{self._image_counter:04d}.png"), pixels)


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


__all__ = ("GoesSimulator", "SimTick")
