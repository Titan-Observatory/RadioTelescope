from __future__ import annotations

from abc import ABC, abstractmethod

from radiotelescope.models.state import PositionReading


class PositionSensor(ABC):
    """Abstract position sensor — reads Az/El from physical feedback hardware."""

    @abstractmethod
    def read(self) -> PositionReading: ...

    def close(self) -> None:
        pass


class MockPositionSensor(PositionSensor):
    """Returns a fixed position; useful for development and tests."""

    def __init__(self, az: float = 180.0, el: float = 45.0) -> None:
        self._az = az
        self._el = el

    def read(self) -> PositionReading:
        return PositionReading(
            azimuth_deg=self._az,
            elevation_deg=self._el,
            available=True,
        )
