from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class MotorState(BaseModel):
    axis: str
    duty: int = 0
    direction: Literal["forward", "reverse", "stopped"] = "stopped"
    is_moving: bool = False


class SensorReading(BaseModel):
    bus_voltage_v: float = 0.0
    shunt_voltage_mv: float = 0.0
    current_a: float = 0.0
    power_w: float = 0.0
    timestamp: float = 0.0


class SafetyStatus(BaseModel):
    overcurrent_tripped: bool = False
    last_trip_timestamp: float | None = None


class TelescopeState(BaseModel):
    motors: dict[str, MotorState]
    sensor: SensorReading
    safety: SafetyStatus
    uptime_s: float = 0.0
