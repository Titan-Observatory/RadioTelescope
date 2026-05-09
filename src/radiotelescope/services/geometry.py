from __future__ import annotations

from functools import lru_cache

import numpy as np

from ..config import AltitudeCalibrationConfig, MountConfig


@lru_cache(maxsize=4)
def _fit_alt_to_counts(cal_key: tuple[tuple[float, int], ...]) -> tuple[float, float, float]:
    """Return (A, B, C) for counts ≈ A·alt² + B·alt + C through the calibration points.

    Two points: linear (A=0). Three: exact quadratic. 4+: least-squares quadratic.
    Cached because the polynomial is the same for the lifetime of a config block.
    """
    alts = np.array([p[0] for p in cal_key], dtype=float)
    counts = np.array([p[1] for p in cal_key], dtype=float)
    deg = 1 if len(cal_key) < 3 else 2
    coeffs = np.polyfit(alts, counts, deg)
    if deg == 1:
        return (0.0, float(coeffs[0]), float(coeffs[1]))
    return (float(coeffs[0]), float(coeffs[1]), float(coeffs[2]))


def _coeffs_for(cal: AltitudeCalibrationConfig) -> tuple[float, float, float]:
    return _fit_alt_to_counts(tuple((p.alt_deg, p.counts) for p in cal.points))


def altitude_to_encoder_counts(alt_deg: float, mount: MountConfig) -> int:
    """Convert a desired altitude (deg) to an absolute M2 encoder target.

    `alt_zero_count` applies as an additive offset on both paths so that the
    sync endpoint can re-anchor the axis without rebuilding the calibration.
    """
    cal = mount.altitude_calibration
    if cal is None:
        return int(round(mount.alt_zero_count + alt_deg * mount.alt_counts_per_degree))
    A, B, C = _coeffs_for(cal)
    return int(round(mount.alt_zero_count + A * alt_deg * alt_deg + B * alt_deg + C))


def encoder_counts_to_altitude(counts: int, mount: MountConfig) -> float:
    """Convert an M2 encoder count to altitude (deg)."""
    cal = mount.altitude_calibration
    raw = counts - mount.alt_zero_count
    if cal is None:
        return raw / mount.alt_counts_per_degree
    A, B, C = _coeffs_for(cal)
    if A == 0:
        return (raw - C) / B
    # Solve A·alt² + B·alt + (C − raw) = 0; pick the root inside the
    # calibration's altitude span (closest to its midpoint).
    disc = B * B - 4 * A * (C - raw)
    if disc < 0:
        return (raw - C) / B if B != 0 else 0.0
    sqrt_disc = disc ** 0.5
    r1 = (-B + sqrt_disc) / (2 * A)
    r2 = (-B - sqrt_disc) / (2 * A)
    mid = sum(p.alt_deg for p in cal.points) / len(cal.points)
    return r1 if abs(r1 - mid) <= abs(r2 - mid) else r2
