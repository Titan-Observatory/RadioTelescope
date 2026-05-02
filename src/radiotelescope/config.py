from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


class RoboClawConfig(BaseModel):
    port: str = "/dev/ttyACM0"
    baudrate: int = Field(default=38400, gt=0)
    address: int = Field(default=0x80, ge=0x80, le=0x87)
    timeout_s: float = Field(default=0.25, gt=0)
    connect_mode: Literal["auto", "serial", "simulated"] = "auto"


class TelemetryConfig(BaseModel):
    update_rate_hz: int = Field(default=5, ge=1, le=50)


class TerminalConfig(BaseModel):
    enabled: bool = True
    shell: str | None = None


class MountConfig(BaseModel):
    az_counts_per_degree: float = Field(default=1000.0, gt=0)
    alt_counts_per_degree: float = Field(default=1000.0, gt=0)
    az_zero_count: int = 0
    alt_zero_count: int = 0
    goto_speed_qpps: int = Field(default=10_000, ge=0)
    goto_accel_qpps2: int = Field(default=25_000, ge=0)
    goto_decel_qpps2: int = Field(default=25_000, ge=0)


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    allowed_clients: list[str] = Field(default_factory=lambda: ["10.0.27.1", "10.0.27.2"])


class GeneralConfig(BaseModel):
    log_level: str = "INFO"


class AppConfig(BaseModel):
    general: GeneralConfig = Field(default_factory=GeneralConfig)
    roboclaw: RoboClawConfig = Field(default_factory=RoboClawConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    terminal: TerminalConfig = Field(default_factory=TerminalConfig)
    mount: MountConfig = Field(default_factory=MountConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)


def load_config(path: Path | str = "config.toml") -> AppConfig:
    path = Path(path)
    with path.open("rb") as f:
        raw = tomllib.load(f)
    return AppConfig.model_validate(raw)
