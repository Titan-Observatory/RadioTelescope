from __future__ import annotations

from radiotelescope.hardware import current_sensor as current_sensor_module
from radiotelescope.hardware.current_sensor import INA226


class _FailingBus:
    def write_i2c_block_data(self, addr, reg, data) -> None:
        raise OSError(5, "Input/output error")

    def read_i2c_block_data(self, addr, reg, length):
        raise OSError(5, "Input/output error")

    def close(self) -> None:
        pass


class _RecoveringBus:
    def __init__(self, fail_reads: bool) -> None:
        self._fail_reads = fail_reads

    def write_i2c_block_data(self, addr, reg, data) -> None:
        return None

    def read_i2c_block_data(self, addr, reg, length):
        if self._fail_reads and reg == 0x02:
            raise OSError(5, "Input/output error")

        registers = {
            0x01: [0x00, 0x64],
            0x02: [0x25, 0x80],
            0x03: [0x00, 0x10],
            0x04: [0x00, 0x08],
        }
        return registers[reg]

    def close(self) -> None:
        pass


def test_init_failure_returns_unavailable_reading(test_config, monkeypatch):
    monkeypatch.setattr(current_sensor_module.smbus2, "SMBus", lambda bus: _FailingBus())

    sensor = INA226(test_config.i2c)
    reading = sensor.read()

    assert sensor.available is False
    assert reading.available is False
    sensor.close()


def test_sensor_recovers_after_transient_i2c_failure(test_config, monkeypatch):
    monkeypatch.setattr(current_sensor_module, "_RETRY_INTERVAL_S", 0.0)

    buses = [_RecoveringBus(fail_reads=True), _RecoveringBus(fail_reads=False)]

    def make_bus(bus_number: int):
        return buses.pop(0)

    monkeypatch.setattr(current_sensor_module.smbus2, "SMBus", make_bus)

    sensor = INA226(test_config.i2c)

    first = sensor.read()
    second = sensor.read()

    assert first.available is False
    assert second.available is True
    assert sensor.available is True
    sensor.close()
