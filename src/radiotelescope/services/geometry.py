from __future__ import annotations

from ..config import AltitudeCalibrationConfig, MountConfig


def _fit_alt_to_counts(cal: AltitudeCalibrationConfig) -> tuple[float, float, float]:
    """Return (A, B, C) such that counts ≈ A·alt² + B·alt + C, fit through the points.

    Two points: linear fit (A=0). Three points: exact quadratic. 4+: least-squares
    quadratic via the normal equations.
    """
    pts = cal.points
    if len(pts) == 2:
        x0, y0 = pts[0].alt_deg, pts[0].counts
        x1, y1 = pts[1].alt_deg, pts[1].counts
        slope = (y1 - y0) / (x1 - x0)
        return (0.0, slope, y0 - slope * x0)

    # Quadratic fit. For exactly 3 points this is exact; for more it's
    # a least-squares fit by Cramer/normal equations on the 3×3 system.
    s0 = float(len(pts))
    s1 = sum(p.alt_deg for p in pts)
    s2 = sum(p.alt_deg ** 2 for p in pts)
    s3 = sum(p.alt_deg ** 3 for p in pts)
    s4 = sum(p.alt_deg ** 4 for p in pts)
    t0 = sum(p.counts for p in pts)
    t1 = sum(p.counts * p.alt_deg for p in pts)
    t2 = sum(p.counts * p.alt_deg ** 2 for p in pts)
    # Solve [[s4 s3 s2],[s3 s2 s1],[s2 s1 s0]] @ [A B C] = [t2 t1 t0] by Cramer's.
    M = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]]
    rhs = [t2, t1, t0]
    det = _det3(M)
    if det == 0:
        x0, y0 = pts[0].alt_deg, pts[0].counts
        x1, y1 = pts[-1].alt_deg, pts[-1].counts
        slope = (y1 - y0) / (x1 - x0)
        return (0.0, slope, y0 - slope * x0)
    A = _det3([[rhs[0], M[0][1], M[0][2]], [rhs[1], M[1][1], M[1][2]], [rhs[2], M[2][1], M[2][2]]]) / det
    B = _det3([[M[0][0], rhs[0], M[0][2]], [M[1][0], rhs[1], M[1][2]], [M[2][0], rhs[2], M[2][2]]]) / det
    C = _det3([[M[0][0], M[0][1], rhs[0]], [M[1][0], M[1][1], rhs[1]], [M[2][0], M[2][1], rhs[2]]]) / det
    return (A, B, C)


def _det3(m: list[list[float]]) -> float:
    return (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )


def altitude_to_encoder_counts(alt_deg: float, mount: MountConfig) -> int:
    """Convert a desired altitude (deg) to an absolute M2 encoder target."""
    cal = mount.altitude_calibration
    if cal is None:
        return int(round(mount.alt_zero_count + alt_deg * mount.alt_counts_per_degree))
    A, B, C = _fit_alt_to_counts(cal)
    return int(round(A * alt_deg * alt_deg + B * alt_deg + C))


def encoder_counts_to_altitude(counts: int, mount: MountConfig) -> float:
    """Convert an M2 encoder count to altitude (deg)."""
    cal = mount.altitude_calibration
    if cal is None:
        return (counts - mount.alt_zero_count) / mount.alt_counts_per_degree
    A, B, C = _fit_alt_to_counts(cal)
    if A == 0:
        return (counts - C) / B
    # Solve A·alt² + B·alt + (C - counts) = 0; pick the root inside the
    # calibration's altitude span (closest to the midpoint of the points).
    disc = B * B - 4 * A * (C - counts)
    if disc < 0:
        return (counts - C) / B if B != 0 else 0.0
    sqrt_disc = disc ** 0.5
    r1 = (-B + sqrt_disc) / (2 * A)
    r2 = (-B - sqrt_disc) / (2 * A)
    mid = sum(p.alt_deg for p in cal.points) / len(cal.points)
    return r1 if abs(r1 - mid) <= abs(r2 - mid) else r2
