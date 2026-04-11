import time
from unittest.mock import MagicMock

from radiotelescope.config import SafetyConfig
from radiotelescope.models.state import SensorReading
from radiotelescope.safety.interlocks import SafetyMonitor


def _reading(current_a: float) -> SensorReading:
    return SensorReading(
        bus_voltage_v=12.0,
        shunt_voltage_mv=0.5,
        current_a=current_a,
        power_w=current_a * 12.0,
        timestamp=time.time(),
    )


def _make_monitor(holdoff: float = 0.0) -> SafetyMonitor:
    cfg = SafetyConfig(
        overcurrent_threshold_a=5.0,
        overcurrent_holdoff_s=holdoff,
    )
    ina = MagicMock()
    return SafetyMonitor(cfg, ina)


def test_normal_current_is_safe():
    mon = _make_monitor()
    assert mon.check_current(_reading(3.0)) is True
    assert not mon.status.overcurrent_tripped


def test_overcurrent_trips_after_holdoff():
    mon = _make_monitor(holdoff=0.0)
    # With zero holdoff, first sustained overcurrent should trip
    mon.check_current(_reading(6.0))  # starts timer
    result = mon.check_current(_reading(6.0))  # holdoff elapsed (0s)
    assert result is False
    assert mon.status.overcurrent_tripped


def test_transient_spike_resets():
    mon = _make_monitor(holdoff=1.0)
    mon.check_current(_reading(6.0))  # starts timer
    mon.check_current(_reading(3.0))  # back to normal → resets timer
    assert mon.check_current(_reading(3.0)) is True
    assert not mon.status.overcurrent_tripped


def test_emergency_stop():
    mon = _make_monitor()
    m1, m2 = MagicMock(), MagicMock()
    mon.emergency_stop([m1, m2])
    m1.stop.assert_called_once()
    m2.stop.assert_called_once()


def test_reset():
    mon = _make_monitor(holdoff=0.0)
    mon.check_current(_reading(6.0))
    mon.check_current(_reading(6.0))
    assert mon.status.overcurrent_tripped
    mon.reset()
    assert not mon.status.overcurrent_tripped
