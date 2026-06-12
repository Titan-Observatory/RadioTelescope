"""Look angles to a geostationary satellite.

GOES satellites are fixed in the sky for a fixed observer, so a closed-form
spherical-Earth calculation is plenty — the dish beam (a degree or more at
1.69 GHz) dwarfs the ellipsoidal correction (< 0.2°). This keeps katpoint out
of the hot path and gives the frontend a single authoritative az/el per
satellite via ``/api/observation``.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

GEO_ORBIT_RADIUS_KM = 42_164.0
EARTH_RADIUS_KM = 6_378.137


@dataclass(frozen=True)
class LookAngles:
    azimuth_deg: float
    elevation_deg: float
    range_km: float

    @property
    def visible(self) -> bool:
        return self.elevation_deg > 0.0


def look_angles(observer_lat_deg: float, observer_lon_deg: float, satellite_lon_deg: float) -> LookAngles:
    """Azimuth/elevation/range from an observer to a geostationary satellite.

    Azimuth follows the telescope convention: degrees clockwise from true
    north. Elevation is negative when the satellite is below the horizon.
    """
    lat = math.radians(observer_lat_deg)
    # Longitude difference from observer to the sub-satellite point, wrapped
    # to ±180° so the azimuth comes out on the short way round.
    dlon = math.radians(((satellite_lon_deg - observer_lon_deg + 180.0) % 360.0) - 180.0)

    # Central angle between the observer and the sub-satellite point (lat 0).
    cos_gamma = math.cos(lat) * math.cos(dlon)

    ratio = EARTH_RADIUS_KM / GEO_ORBIT_RADIUS_KM
    range_km = GEO_ORBIT_RADIUS_KM * math.sqrt(1.0 + ratio * ratio - 2.0 * ratio * cos_gamma)

    sin_gamma = math.sqrt(max(0.0, 1.0 - cos_gamma * cos_gamma))
    if sin_gamma < 1e-9:
        # Observer is (anti)sub-satellite: straight up or straight down.
        elevation_deg = 90.0 if cos_gamma > 0 else -90.0
    else:
        elevation_deg = math.degrees(math.atan2(cos_gamma - ratio, sin_gamma))

    # Great-circle initial bearing to the sub-satellite point (lat2 = 0).
    az = math.atan2(math.sin(dlon), -math.sin(lat) * math.cos(dlon))
    azimuth_deg = math.degrees(az) % 360.0

    return LookAngles(azimuth_deg=azimuth_deg, elevation_deg=elevation_deg, range_km=range_km)


def angular_separation_deg(alt1_deg: float, az1_deg: float, alt2_deg: float, az2_deg: float) -> float:
    """Great-circle separation between two alt/az directions."""
    a1, a2 = math.radians(alt1_deg), math.radians(alt2_deg)
    dz = math.radians(az2_deg - az1_deg)
    cos_sep = math.sin(a1) * math.sin(a2) + math.cos(a1) * math.cos(a2) * math.cos(dz)
    return math.degrees(math.acos(max(-1.0, min(1.0, cos_sep))))


__all__ = ("LookAngles", "look_angles", "angular_separation_deg")
