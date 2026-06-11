from __future__ import annotations

import pytest

from rt_hardware.config import ObserverConfig
from rt_hardware.pointing import altaz_to_radec, make_antenna, radec_to_altaz


@pytest.fixture
def antenna():
    return make_antenna(ObserverConfig())


def test_altaz_radec_round_trip(antenna):
    ra, dec = altaz_to_radec(45.0, 180.0, antenna)
    assert 0.0 <= ra < 360.0
    assert -90.0 <= dec <= 90.0

    alt, az = radec_to_altaz(ra, dec, antenna)
    assert alt == pytest.approx(45.0, abs=0.05)
    assert az == pytest.approx(180.0, abs=0.05)


def test_altaz_to_radec_absolute_units(antenna):
    """Catch unit mix-ups (hours vs degrees) that a round trip can mask.

    Pointing due south at altitude (90° − latitude) lands on the celestial
    equator, so declination must be ~0° regardless of observation time.
    """
    cfg = ObserverConfig()
    _, dec = altaz_to_radec(90.0 - cfg.latitude_deg, 180.0, antenna)
    assert dec == pytest.approx(0.0, abs=1.0)


def test_radec_to_altaz_dec_at_pole(antenna):
    """The celestial pole sits at altitude = latitude, azimuth = north,
    independent of RA and time — another absolute check on the units."""
    cfg = ObserverConfig()
    alt, az = radec_to_altaz(123.456, 90.0, antenna)
    assert alt == pytest.approx(cfg.latitude_deg, abs=1.0)
