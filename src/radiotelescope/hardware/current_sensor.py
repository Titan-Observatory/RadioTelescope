from __future__ import annotations

import logging
import time

import smbus2

from radiotelescope.config import I2CConfig
from radiotelescope.models.state import SensorReading

logger = logging.getLogger(__name__)

# INA226 register addresses
_REG_CONFIG = 0x00
_REG_SHUNT_VOLTAGE = 0x01
_REG_BUS_VOLTAGE = 0x02
_REG_POWER = 0x03
_REG_CURRENT = 0x04
_REG_CALIBRATION = 0x05

# LSB constants
_BUS_VOLTAGE_LSB = 1.25e-3       # 1.25 mV per bit
_SHUNT_VOLTAGE_LSB = 2.5e-3      # 2.5 µV per bit → mV after *1e-3


class INA226:
    """Driver for the INA226 current/power monitor over I2C."""

    def __init__(self, config: I2CConfig) -> None:
        self._addr = config.ina226_address
        self._shunt_r = config.ina226.shunt_resistor_ohms
        self._bus = smbus2.SMBus(config.bus)

        self._current_lsb = 0.0
        self.configure(config)

    def configure(self, config: I2CConfig) -> None:
        avg = config.ina226.averaging_mode & 0x07
        vbusct = self._conversion_bits(config.ina226.bus_voltage_conversion_time_us)
        vshct = self._conversion_bits(config.ina226.shunt_voltage_conversion_time_us)
        cfg_word = (avg << 9) | (vbusct << 6) | (vshct << 3) | 0x07  # continuous shunt+bus
        self._write_register(_REG_CONFIG, cfg_word)

        # Calibration: CAL = 0.00512 / (current_lsb * R_shunt)
        # Choose current_lsb for ~1 mA resolution
        self._current_lsb = 0.001
        cal = int(0.00512 / (self._current_lsb * self._shunt_r))
        self._write_register(_REG_CALIBRATION, cal)
        logger.info("INA226 configured: addr=0x%02X, cal=%d", self._addr, cal)

    def read(self) -> SensorReading:
        raw_bus = self._read_register(_REG_BUS_VOLTAGE)
        raw_shunt = self._read_register_signed(_REG_SHUNT_VOLTAGE)
        raw_current = self._read_register_signed(_REG_CURRENT)
        raw_power = self._read_register(_REG_POWER)

        bus_v = raw_bus * _BUS_VOLTAGE_LSB
        shunt_mv = raw_shunt * _SHUNT_VOLTAGE_LSB
        current_a = raw_current * self._current_lsb
        power_w = raw_power * self._current_lsb * 25  # power LSB = 25 × current LSB

        return SensorReading(
            bus_voltage_v=round(bus_v, 4),
            shunt_voltage_mv=round(shunt_mv, 4),
            current_a=round(current_a, 4),
            power_w=round(power_w, 4),
            timestamp=time.time(),
        )

    def close(self) -> None:
        self._bus.close()

    # -- low-level helpers --

    def _write_register(self, reg: int, value: int) -> None:
        high = (value >> 8) & 0xFF
        low = value & 0xFF
        self._bus.write_i2c_block_data(self._addr, reg, [high, low])

    def _read_register(self, reg: int) -> int:
        data = self._bus.read_i2c_block_data(self._addr, reg, 2)
        return (data[0] << 8) | data[1]

    def _read_register_signed(self, reg: int) -> int:
        val = self._read_register(reg)
        if val >= 0x8000:
            val -= 0x10000
        return val

    @staticmethod
    def _conversion_bits(time_us: int) -> int:
        thresholds = [140, 204, 332, 588, 1100, 2116, 4156, 8244]
        for i, t in enumerate(thresholds):
            if time_us <= t:
                return i
        return 7
