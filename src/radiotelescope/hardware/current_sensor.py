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
_BUS_VOLTAGE_LSB = 1.25e-3  # 1.25 mV per bit
_SHUNT_VOLTAGE_LSB = 2.5e-3  # 2.5 uV per bit -> mV after scaling
_RETRY_INTERVAL_S = 2.0


class INA226:
    """Driver for the INA226 current/power monitor over I2C."""

    def __init__(self, config: I2CConfig) -> None:
        self._config = config
        self._bus_number = config.bus
        self._addr = config.ina226_address
        self._shunt_r = config.ina226.shunt_resistor_ohms
        self._bus: smbus2.SMBus | None = None
        self._current_lsb = 0.0
        self._available = False
        self._next_retry_at = 0.0
        self._fault_context: str | None = None
        self._ensure_ready(force=True)

    @property
    def available(self) -> bool:
        return self._available

    def configure(self, config: I2CConfig) -> None:
        avg = config.ina226.averaging_mode & 0x07
        vbusct = self._conversion_bits(config.ina226.bus_voltage_conversion_time_us)
        vshct = self._conversion_bits(config.ina226.shunt_voltage_conversion_time_us)
        cfg_word = (avg << 9) | (vbusct << 6) | (vshct << 3) | 0x07
        self._write_register(_REG_CONFIG, cfg_word)

        # Calibration: CAL = 0.00512 / (current_lsb * R_shunt)
        # Choose current_lsb for ~1 mA resolution
        self._current_lsb = 0.001
        cal = int(0.00512 / (self._current_lsb * self._shunt_r))
        self._write_register(_REG_CALIBRATION, cal)
        logger.info("INA226 configured: addr=0x%02X, cal=%d", self._addr, cal)

    def read(self) -> SensorReading:
        if not self._ensure_ready():
            return self._unavailable_reading()

        try:
            raw_bus = self._read_register(_REG_BUS_VOLTAGE)
            raw_shunt = self._read_register_signed(_REG_SHUNT_VOLTAGE)
            raw_current = self._read_register_signed(_REG_CURRENT)
            raw_power = self._read_register(_REG_POWER)
        except OSError as exc:
            self._mark_fault("read", exc)
            return self._unavailable_reading()

        bus_v = raw_bus * _BUS_VOLTAGE_LSB
        shunt_mv = raw_shunt * _SHUNT_VOLTAGE_LSB
        current_a = raw_current * self._current_lsb
        power_w = raw_power * self._current_lsb * 25  # power LSB = 25 x current LSB

        self._clear_fault()
        return SensorReading(
            bus_voltage_v=round(bus_v, 4),
            shunt_voltage_mv=round(shunt_mv, 4),
            current_a=round(current_a, 4),
            power_w=round(power_w, 4),
            timestamp=time.time(),
            available=True,
        )

    def close(self) -> None:
        if self._bus is not None:
            self._bus.close()
            self._bus = None
        self._available = False

    # -- low-level helpers --

    def _ensure_ready(self, force: bool = False) -> bool:
        now = time.time()
        if self._bus is not None and self._available:
            return True
        if not force and now < self._next_retry_at:
            return False

        if self._bus is None:
            try:
                self._bus = smbus2.SMBus(self._bus_number)
            except OSError as exc:
                self._mark_fault("open", exc)
                return False

        try:
            self.configure(self._config)
        except OSError as exc:
            self._mark_fault("configure", exc)
            return False

        self._clear_fault()
        return True

    def _mark_fault(self, context: str, exc: OSError) -> None:
        already_reported = (not self._available) and self._fault_context == context
        if self._bus is not None:
            try:
                self._bus.close()
            except OSError:
                pass
            self._bus = None
        self._available = False
        self._fault_context = context
        self._next_retry_at = time.time() + _RETRY_INTERVAL_S
        if not already_reported:
            logger.warning(
                "INA226 unavailable during %s on bus %d addr=0x%02X: %s",
                context,
                self._bus_number,
                self._addr,
                exc,
            )

    def _clear_fault(self) -> None:
        recovered = (not self._available) and (self._fault_context is not None)
        self._available = True
        self._next_retry_at = 0.0
        self._fault_context = None
        if recovered:
            logger.info(
                "INA226 communication restored on bus %d addr=0x%02X",
                self._bus_number,
                self._addr,
            )

    @staticmethod
    def _unavailable_reading() -> SensorReading:
        return SensorReading(
            timestamp=time.time(),
            available=False,
        )

    def _write_register(self, reg: int, value: int) -> None:
        if self._bus is None:
            raise OSError("I2C bus is not open")
        high = (value >> 8) & 0xFF
        low = value & 0xFF
        self._bus.write_i2c_block_data(self._addr, reg, [high, low])

    def _read_register(self, reg: int) -> int:
        if self._bus is None:
            raise OSError("I2C bus is not open")
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
        for i, threshold in enumerate(thresholds):
            if time_us <= threshold:
                return i
        return 7
