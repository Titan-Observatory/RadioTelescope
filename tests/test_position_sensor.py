from __future__ import annotations

import pytest

from radiotelescope.config import PositionAxisConfig, PositionSensorConfig
from radiotelescope.hardware.mcp3008 import _adc_to_deg
from radiotelescope.hardware.position_sensor import MockPositionSensor


# ---------------------------------------------------------------------------
# MockPositionSensor
# ---------------------------------------------------------------------------


def test_mock_returns_configured_position():
    sensor = MockPositionSensor(az=90.0, el=30.0)
    reading = sensor.read()
    assert reading.available is True
    assert reading.azimuth_deg == pytest.approx(90.0)
    assert reading.elevation_deg == pytest.approx(30.0)


def test_mock_default_position():
    sensor = MockPositionSensor()
    reading = sensor.read()
    assert reading.available is True
    assert 0.0 <= reading.azimuth_deg <= 360.0
    assert 0.0 <= reading.elevation_deg <= 90.0


# ---------------------------------------------------------------------------
# ADC → degrees linear mapping
# ---------------------------------------------------------------------------


def test_adc_to_deg_full_range():
    axis = PositionAxisConfig(min_adc=0, max_adc=1023, min_deg=0.0, max_deg=360.0)
    assert _adc_to_deg(0, axis) == pytest.approx(0.0)
    assert _adc_to_deg(1023, axis) == pytest.approx(360.0)


def test_adc_to_deg_midpoint():
    axis = PositionAxisConfig(min_adc=0, max_adc=1000, min_deg=0.0, max_deg=100.0)
    assert _adc_to_deg(500, axis) == pytest.approx(50.0)


def test_adc_to_deg_elevation_range():
    axis = PositionAxisConfig(
        adc_channel=1, min_adc=100, max_adc=900, min_deg=5.0, max_deg=85.0
    )
    assert _adc_to_deg(100, axis) == pytest.approx(5.0)
    assert _adc_to_deg(900, axis) == pytest.approx(85.0)
    mid_adc = (100 + 900) // 2  # 500
    assert _adc_to_deg(mid_adc, axis) == pytest.approx(45.0)


def test_adc_to_deg_clamps_below_min():
    axis = PositionAxisConfig(min_adc=100, max_adc=900, min_deg=0.0, max_deg=90.0)
    assert _adc_to_deg(0, axis) == pytest.approx(0.0)


def test_adc_to_deg_clamps_above_max():
    axis = PositionAxisConfig(min_adc=100, max_adc=900, min_deg=0.0, max_deg=90.0)
    assert _adc_to_deg(1023, axis) == pytest.approx(90.0)


def test_adc_to_deg_zero_span_returns_min():
    axis = PositionAxisConfig(min_adc=512, max_adc=512, min_deg=45.0, max_deg=45.0)
    assert _adc_to_deg(512, axis) == pytest.approx(45.0)
