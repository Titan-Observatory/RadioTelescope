from __future__ import annotations

import logging

import lgpio

from radiotelescope.config import PositionAxisConfig, PositionSensorConfig
from radiotelescope.hardware.position_sensor import PositionSensor
from radiotelescope.models.state import PositionReading

logger = logging.getLogger(__name__)


def _adc_to_deg(adc: int, axis: PositionAxisConfig) -> float:
    """Map a raw 10-bit ADC value linearly onto the configured angle range."""
    span_adc = axis.max_adc - axis.min_adc
    if span_adc == 0:
        return axis.min_deg
    t = (adc - axis.min_adc) / span_adc
    t = max(0.0, min(1.0, t))
    return axis.min_deg + t * (axis.max_deg - axis.min_deg)


class MCP3008PositionSensor(PositionSensor):
    """Reads two potentiometers via an MCP3008 10-bit ADC over SPI.

    The MCP3008 communicates via 3-byte SPI frames:
      TX: [0x01, 0x80|(channel<<4), 0x00]
      RX: [don't-care, B9:B8, B7:B0]
    Result = ((rx[1] & 0x03) << 8) | rx[2]  →  0–1023

    SPI is opened through lgpio's spi_open() which uses the kernel SPI driver
    (/dev/spidev<spi_device>.<spi_channel>) — no separate GPIO handle needed.
    """

    def __init__(self, config: PositionSensorConfig) -> None:
        self._cfg = config
        self._handle = -1
        try:
            self._handle = lgpio.spi_open(
                config.spi_device,
                config.spi_channel,
                config.baud,
                0,  # SPI mode 0,0
            )
            if self._handle < 0:
                logger.warning(
                    "MCP3008: spi_open returned error %d (SPI not available?)",
                    self._handle,
                )
                self._handle = -1
            else:
                logger.info(
                    "MCP3008: opened SPI%d.%d at %d baud",
                    config.spi_device,
                    config.spi_channel,
                    config.baud,
                )
        except Exception as exc:
            logger.warning("MCP3008: could not open SPI: %s", exc)

    def _read_channel(self, channel: int) -> int:
        """Return raw 10-bit ADC reading for the given MCP3008 channel (0–7)."""
        tx = bytes([0x01, 0x80 | (channel << 4), 0x00])
        count, rx = lgpio.spi_xfer(self._handle, tx)
        if count != 3:
            raise OSError(f"SPI xfer returned {count} bytes, expected 3")
        return ((rx[1] & 0x03) << 8) | rx[2]

    def read(self) -> PositionReading:
        if self._handle < 0:
            return PositionReading(available=False)
        try:
            az_raw = self._read_channel(self._cfg.azimuth.adc_channel)
            el_raw = self._read_channel(self._cfg.elevation.adc_channel)
            return PositionReading(
                azimuth_deg=_adc_to_deg(az_raw, self._cfg.azimuth),
                elevation_deg=_adc_to_deg(el_raw, self._cfg.elevation),
                available=True,
            )
        except Exception as exc:
            logger.warning("MCP3008 read failed: %s", exc)
            return PositionReading(available=False)

    def close(self) -> None:
        if self._handle >= 0:
            lgpio.spi_close(self._handle)
            self._handle = -1
