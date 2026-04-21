from radiotelescope.config import AppConfig


def test_load_config(test_config: AppConfig):
    assert test_config.motors.azimuth.rpwm_pin == 5
    assert test_config.motors.elevation.rpwm_pin == 20
    assert test_config.i2c.ina226_address == 0x40
    assert test_config.safety.overcurrent_threshold_a == 5.0
    assert test_config.sdr.center_freq_hz == 1_420_405_000
    assert test_config.general.update_rate_hz == 10


def test_motor_config_defaults(test_config: AppConfig):
    assert test_config.motors.azimuth.ramp_time_s == 3.0  # default
    assert test_config.motors.azimuth.max_duty == 80


def test_server_config(test_config: AppConfig):
    assert test_config.server.host == "127.0.0.1"
    assert test_config.server.port == 8000
