from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from radiotelescope.config import AppConfig, load_config
from radiotelescope.models.state import SensorReading

# ---------------------------------------------------------------------------
# Minimal config TOML for tests (no real hardware needed)
# ---------------------------------------------------------------------------

_TEST_CONFIG = """\
[general]
log_level = "DEBUG"
update_rate_hz = 10

[i2c]
bus = 1
ina226_address = 0x40

[i2c.ina226]
shunt_resistor_ohms = 0.01

[motors.azimuth]
rpwm_pin = 5
lpwm_pin = 6
max_duty = 80

[motors.elevation]
rpwm_pin = 20
lpwm_pin = 21
max_duty = 60

[safety]
overcurrent_threshold_a = 5.0
overcurrent_holdoff_s = 0.5

[sdr]
device_index = 0
center_freq_hz = 1420405000

[server]
host = "127.0.0.1"
port = 8000

[observer]
latitude = 51.5
longitude = -0.1
elevation_m = 0.0

[position_sensor]
type = "mock"
"""


@pytest.fixture
def test_config_path(tmp_path: Path) -> Path:
    p = tmp_path / "config.toml"
    p.write_text(_TEST_CONFIG)
    return p


@pytest.fixture
def test_config(test_config_path: Path) -> AppConfig:
    return load_config(test_config_path)


# ---------------------------------------------------------------------------
# Mock hardware
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_handle(monkeypatch) -> int:
    """Patch lgpio so no real GPIO calls are made in tests."""
    import lgpio as _lgpio
    monkeypatch.setattr(_lgpio, "gpio_claim_output", lambda h, pin: None)
    monkeypatch.setattr(_lgpio, "tx_pwm", lambda h, pin, freq, duty: None)
    monkeypatch.setattr(_lgpio, "gpio_free", lambda h, pin: None)
    return 0  # fake handle integer


@pytest.fixture
def mock_motor(test_config: AppConfig, mock_handle: int):
    from radiotelescope.hardware.motor import IBT2Motor

    return IBT2Motor(test_config.motors.azimuth, mock_handle)


@pytest.fixture
def mock_ina226() -> MagicMock:
    sensor = MagicMock()
    sensor.available = True
    sensor.read.return_value = SensorReading(
        bus_voltage_v=12.0,
        shunt_voltage_mv=0.5,
        current_a=1.0,
        power_w=12.0,
        timestamp=0.0,
    )
    return sensor


@pytest.fixture
def mock_position_sensor():
    from radiotelescope.hardware.position_sensor import MockPositionSensor

    return MockPositionSensor(az=180.0, el=45.0)
