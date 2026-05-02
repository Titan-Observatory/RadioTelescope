from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


ConnectionMode = Literal["serial", "simulated", "error"]
ArgType = Literal["u8", "u16", "s16", "u32", "s32", "bool"]


class ConnectionStatus(BaseModel):
    mode: ConnectionMode
    port: str
    baudrate: int
    address: int
    connected: bool
    message: str | None = None


class MotorSnapshot(BaseModel):
    command: int = 0
    pwm: int | None = None
    current_a: float | None = None
    encoder: int | None = None
    encoder_status: int | None = None
    speed_qpps: int | None = None
    raw_speed_qpps: int | None = None
    average_speed_qpps: int | None = None
    speed_error_qpps: int | None = None
    position_error: int | None = None


class RoboClawTelemetry(BaseModel):
    connection: ConnectionStatus
    timestamp: float
    firmware: str | None = None
    main_battery_v: float | None = None
    logic_battery_v: float | None = None
    temperature_c: float | None = None
    temperature_2_c: float | None = None
    status: int | None = None
    status_flags: list[str] = Field(default_factory=list)
    buffer_depths: dict[str, int | None] = Field(default_factory=dict)
    encoder_modes: dict[str, int | None] = Field(default_factory=dict)
    motors: dict[str, MotorSnapshot] = Field(default_factory=dict)
    last_error: str | None = None


class CommandArg(BaseModel):
    name: str
    type: ArgType
    label: str
    min: int | None = None
    max: int | None = None
    default: int | bool | None = None


class CommandInfo(BaseModel):
    id: str
    name: str
    group: str
    description: str
    command: int
    kind: Literal["read", "write", "motion", "config"]
    dangerous: bool = False
    args: list[CommandArg] = Field(default_factory=list)


class CommandRequest(BaseModel):
    args: dict[str, int | bool] = Field(default_factory=dict)


class CommandResult(BaseModel):
    command_id: str
    ok: bool
    response: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class HealthStatus(BaseModel):
    status: str = "ok"
    connection: ConnectionStatus
