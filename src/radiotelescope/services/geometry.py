from __future__ import annotations

import math

from ..config import AltitudeActuatorConfig, MountConfig


def _phi_zero_rad(cfg: AltitudeActuatorConfig) -> float:
    """Triangle angle ∠A·axis·B at altitude 0°, derived from the retracted-state anchor."""
    a, b = cfg.a_mm, cfg.b_mm
    L = cfg.l_retracted_mm
    cos_phi = (a * a + b * b - L * L) / (2 * a * b)
    cos_phi = max(-1.0, min(1.0, cos_phi))
    phi_at_retracted = math.acos(cos_phi)
    return phi_at_retracted - math.radians(cfg.alt_at_retracted_deg)


def actuator_length_at_altitude_mm(alt_deg: float, cfg: AltitudeActuatorConfig) -> float:
    phi = _phi_zero_rad(cfg) + math.radians(alt_deg)
    a, b = cfg.a_mm, cfg.b_mm
    return math.sqrt(max(0.0, a * a + b * b - 2 * a * b * math.cos(phi)))


def altitude_at_actuator_length_deg(length_mm: float, cfg: AltitudeActuatorConfig) -> float:
    a, b = cfg.a_mm, cfg.b_mm
    cos_phi = (a * a + b * b - length_mm * length_mm) / (2 * a * b)
    cos_phi = max(-1.0, min(1.0, cos_phi))
    phi = math.acos(cos_phi)
    return math.degrees(phi - _phi_zero_rad(cfg))


def altitude_to_encoder_counts(alt_deg: float, mount: MountConfig) -> int:
    """Convert a desired altitude (deg) to an absolute M2 encoder target."""
    actuator = mount.altitude_actuator
    if actuator is None:
        return int(round(mount.alt_zero_count + alt_deg * mount.alt_counts_per_degree))
    L = actuator_length_at_altitude_mm(alt_deg, actuator)
    raw_counts = (L - actuator.l_retracted_mm) * actuator.pulses_per_mm
    return int(round(mount.alt_zero_count + raw_counts))


def encoder_counts_to_altitude(counts: int, mount: MountConfig) -> float:
    """Convert an M2 encoder count to altitude (deg)."""
    actuator = mount.altitude_actuator
    if actuator is None:
        return (counts - mount.alt_zero_count) / mount.alt_counts_per_degree
    raw_counts = counts - mount.alt_zero_count
    L = actuator.l_retracted_mm + raw_counts / actuator.pulses_per_mm
    return altitude_at_actuator_length_deg(L, actuator)
