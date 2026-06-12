from __future__ import annotations

import math

import pytest

from rt_hardware.goes.pointing import angular_separation_deg, look_angles


def test_subsatellite_observer_sees_satellite_at_zenith():
    angles = look_angles(0.0, -75.2, -75.2)
    assert angles.elevation_deg == pytest.approx(90.0)
    assert angles.range_km == pytest.approx(42_164.0 - 6_378.137, rel=1e-6)
    assert angles.visible


def test_antipodal_observer_cannot_see_satellite():
    angles = look_angles(0.0, 104.8, -75.2)
    assert angles.elevation_deg == pytest.approx(-90.0)
    assert not angles.visible


def test_goes_east_from_washington_dc():
    # Known geometry: GOES-East (75.2°W) from Washington DC (38.9°N 77.0°W)
    # sits high in the southern sky, a touch east of due south.
    angles = look_angles(38.9, -77.0, -75.2)
    assert 40.0 < angles.elevation_deg < 48.0
    assert 175.0 < angles.azimuth_deg < 185.0
    assert angles.visible


def test_goes_west_from_seattle_points_southwest():
    angles = look_angles(47.6, -122.3, -137.0)
    assert 25.0 < angles.elevation_deg < 40.0
    assert 195.0 < angles.azimuth_deg < 230.0


def test_southern_hemisphere_observer_points_north():
    angles = look_angles(-33.9, -70.7, -75.2)  # Santiago → GOES-East
    assert angles.visible
    assert angles.azimuth_deg < 90.0 or angles.azimuth_deg > 270.0


def test_elevation_decreases_with_distance_from_subsatellite_point():
    els = [look_angles(lat, -75.2, -75.2).elevation_deg for lat in (0, 20, 40, 60, 80)]
    assert els == sorted(els, reverse=True)


def test_angular_separation():
    assert angular_separation_deg(45, 180, 45, 180) == pytest.approx(0.0)
    assert angular_separation_deg(0, 0, 0, 90) == pytest.approx(90.0)
    assert angular_separation_deg(89, 0, 89, 180) == pytest.approx(2.0, abs=1e-6)
    # Near the zenith, large azimuth differences are small true separations.
    assert angular_separation_deg(89, 0, 89, 90) < math.sqrt(2.0) * 1.01
