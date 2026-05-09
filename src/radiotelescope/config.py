from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class RoboClawConfig(BaseModel):
    port: str = "/dev/ttyACM0"
    baudrate: int = Field(default=38400, gt=0)
    # Packet Serial uses a one-byte address. BasicMicro may show the default
    # as decimal 128, which is 0x80 in this config, not 0x128.
    address: int = Field(default=0x80, ge=0x80, le=0x87)
    timeout_s: float = Field(default=0.25, gt=0)
    connect_mode: Literal["auto", "serial", "simulated"] = "auto"


class TelemetryConfig(BaseModel):
    update_rate_hz: int = Field(default=5, ge=1, le=50)


class ObserverConfig(BaseModel):
    name: str = "Radio Telescope"
    latitude_deg: float = Field(default=51.5, ge=-90, le=90)
    longitude_deg: float = Field(default=-0.1, ge=-180, le=180)
    altitude_m: float = Field(default=0.0)
    dish_diameter_m: float = Field(default=2.286, gt=0)
    observing_freq_hz: float = Field(default=1.42e9, gt=0)
    beam_fwhm_deg: float | None = None


class AltAzLimitPoint(BaseModel):
    altitude_deg: float = Field(ge=0, le=90)
    azimuth_deg: float = Field(ge=0, le=360)


class AltitudeActuatorConfig(BaseModel):
    """Linear-actuator geometry for the elevation axis.

    Pivot A is fixed on the frame, pivot B is fixed on the dish. The actuator
    forms the third side of a triangle with the elevation axis as the apex.
    a_mm and b_mm are the constant distances from the elevation axis to each
    pivot; the actuator length L between A and B is what changes with encoder
    count, and altitude is recovered from L via the law of cosines.
    """
    a_mm: float = Field(gt=0)
    b_mm: float = Field(gt=0)
    pulses_per_mm: float = Field(gt=0)
    l_retracted_mm: float = Field(gt=0)        # actuator length when encoder counts == 0
    alt_at_retracted_deg: float                  # dish altitude (deg) when encoder counts == 0


class MountConfig(BaseModel):
    az_counts_per_degree: float = Field(default=1000.0, gt=0)
    alt_counts_per_degree: float = Field(default=1000.0, gt=0)
    az_zero_count: int = 0
    alt_zero_count: int = 0
    goto_speed_qpps: int = Field(default=10_000, ge=0)
    goto_accel_qpps2: int = Field(default=25_000, ge=0)
    goto_decel_qpps2: int = Field(default=25_000, ge=0)
    pointing_limit_altaz: list[AltAzLimitPoint] = Field(default_factory=list)
    altitude_actuator: AltitudeActuatorConfig | None = None

    @field_validator("pointing_limit_altaz")
    @classmethod
    def validate_pointing_limit_altaz(cls, value: list[AltAzLimitPoint]) -> list[AltAzLimitPoint]:
        if len(value) not in (0, 3):
            raise ValueError("pointing_limit_altaz must be empty or contain exactly 3 alt/az points")
        return value


class CameraConfig(BaseModel):
    enabled: bool = True
    device: int = Field(default=0, ge=0)
    fps: int = Field(default=15, ge=1, le=60)
    width: int = Field(default=1280, ge=160, le=4096)
    height: int = Field(default=720, ge=120, le=2160)
    label: str = "Cam A"


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    allowed_clients: list[str] = Field(default_factory=lambda: ["10.0.27.1", "10.0.27.2"])
    trusted_proxies: list[str] = Field(default_factory=lambda: ["127.0.0.1", "::1"])
    # When True, only IPs in `allowed_clients` (plus loopback) may reach the
    # server at all. Use for LAN-only deployments. When False, every IP can
    # connect and per-endpoint authorization is delegated to the queue/session
    # layer (`require_control` + `is_lan_admin` admin override).
    lan_only: bool = False


class QueueConfig(BaseModel):
    enabled: bool = True
    max_session_seconds: int = Field(default=600, ge=10)
    idle_timeout_seconds: int = Field(default=60, ge=5)
    max_queue_size: int = Field(default=100, ge=1)
    cookie_secret: str = Field(default="change-me-in-config", min_length=8)
    cookie_name: str = "rt_session"


class TurnstileConfig(BaseModel):
    enabled: bool = True
    site_key: str = ""
    secret_key: str = ""


class GeneralConfig(BaseModel):
    log_level: str = "INFO"


class AppConfig(BaseModel):
    general: GeneralConfig = Field(default_factory=GeneralConfig)
    roboclaw: RoboClawConfig = Field(default_factory=RoboClawConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    mount: MountConfig = Field(default_factory=MountConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    observer: ObserverConfig = Field(default_factory=ObserverConfig)
    camera: CameraConfig = Field(default_factory=CameraConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)
    turnstile: TurnstileConfig = Field(default_factory=TurnstileConfig)


def load_config(path: Path | str = "config.toml") -> AppConfig:
    path = Path(path)
    with path.open("rb") as f:
        raw = tomllib.load(f)
    return AppConfig.model_validate(raw)
