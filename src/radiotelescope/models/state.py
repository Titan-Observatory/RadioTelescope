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
    available: bool = True  # False when hardware is absent or faulted


class SafetyStatus(BaseModel):
    overcurrent_tripped: bool = False
    last_trip_timestamp: float | None = None


class TelescopeState(BaseModel):
    motors: dict[str, MotorState]
    sensor: SensorReading
    safety: SafetyStatus
    uptime_s: float = 0.0


class SessionStatus(BaseModel):
    active: bool = False
    client_id: str | None = None
    claimed_at: float | None = None
    expires_at: float | None = None


class SDRStatus(BaseModel):
    running: bool = False
    center_freq_hz: int = 0
    sample_rate_hz: int = 0
    gain: float | str = 0
    fft_size: int = 0
    integration_count: int = 0
    rolling_window_s: float = 0.0
