from __future__ import annotations

import logging
import time

from radiotelescope.config import SafetyConfig
from radiotelescope.hardware.current_sensor import INA226
from radiotelescope.hardware.motor import IBT2Motor
from radiotelescope.models.state import SafetyStatus, SensorReading

logger = logging.getLogger(__name__)


class SafetyMonitor:
    """Passive safety checker — called by services, not a background loop.

    Two call sites:
      1. TelemetryService on each poll tick → check_current()
      2. MotionService before each move     → check_limits()
    """

    def __init__(self, config: SafetyConfig, ina226: INA226) -> None:
        self._cfg = config
        self._ina226 = ina226
        self._overcurrent_since: float | None = None
        self._tripped = False
        self._last_trip_time: float | None = None
        self._current_monitor_available = getattr(ina226, "available", True)

    @property
    def status(self) -> SafetyStatus:
        return SafetyStatus(
            overcurrent_tripped=self._tripped,
            last_trip_timestamp=self._last_trip_time,
        )

    @property
    def current_monitor_available(self) -> bool:
        return self._current_monitor_available

    def check_current(self, reading: SensorReading) -> bool:
        """Return True if current is within safe limits.

        Uses a holdoff timer to debounce transient spikes.
        """
        if not reading.available:
            if self._current_monitor_available:
                logger.error("INA226 current monitor unavailable; overcurrent protection is degraded until it recovers")
            self._current_monitor_available = False
            self._overcurrent_since = None
            return True

        if not self._current_monitor_available:
            logger.info("INA226 current monitor recovered")
        self._current_monitor_available = True

        if abs(reading.current_a) > self._cfg.overcurrent_threshold_a:
            now = time.time()
            if self._overcurrent_since is None:
                self._overcurrent_since = now
            elif now - self._overcurrent_since >= self._cfg.overcurrent_holdoff_s:
                self._tripped = True
                self._last_trip_time = now
                logger.warning(
                    "OVERCURRENT TRIP: %.3f A > %.3f A threshold",
                    abs(reading.current_a),
                    self._cfg.overcurrent_threshold_a,
                )
                return False
        else:
            self._overcurrent_since = None
        return True

    def check_limits(self, axis: str, _target_deg: float | None = None) -> bool:
        """Check software position limits for a given axis.

        Without encoders we can only validate that the axis name is known
        and that future position targets (when available) fall within bounds.
        Returns True if the move is allowed.
        """
        if axis == "azimuth":
            if _target_deg is not None:
                return self._cfg.azimuth_min_deg <= _target_deg <= self._cfg.azimuth_max_deg
        elif axis == "elevation":
            if _target_deg is not None:
                return self._cfg.elevation_min_deg <= _target_deg <= self._cfg.elevation_max_deg
        else:
            logger.error("Unknown axis: %s", axis)
            return False
        return True

    def emergency_stop(self, motors: list[IBT2Motor]) -> None:
        for motor in motors:
            motor.stop()
        logger.critical("EMERGENCY STOP — all motors halted")

    def reset(self) -> None:
        self._tripped = False
        self._overcurrent_since = None
        logger.info("Safety monitor reset")
