from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Union

from pydantic import BaseModel, Field


class INA226Config(BaseModel):
    shunt_resistor_ohms: float = 0.01
    averaging_mode: int = 4
    bus_voltage_conversion_time_us: int = 1100
    shunt_voltage_conversion_time_us: int = 1100


class I2CConfig(BaseModel):
    bus: int = 1
    ina226_address: int = 0x40
    ina226: INA226Config = Field(default_factory=INA226Config)


class MotorConfig(BaseModel):
    rpwm_pin: int
    lpwm_pin: int
    max_duty: int = 100
    ramp_rate: int = 10


class MotorsConfig(BaseModel):
    azimuth: MotorConfig
    elevation: MotorConfig


class SafetyConfig(BaseModel):
    overcurrent_threshold_a: float = 5.0
    overcurrent_holdoff_s: float = 0.5
    azimuth_min_deg: float = 0.0
    azimuth_max_deg: float = 360.0
    elevation_min_deg: float = 5.0
    elevation_max_deg: float = 85.0


class SDRConfig(BaseModel):
    device_index: int = 0
    center_freq_hz: int = 1_420_405_000
    sample_rate_hz: int = 2_048_000
    gain: Union[str, float] = "auto"
    fft_size: int = 1024
    integration_count: int = 8


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])


class GeneralConfig(BaseModel):
    log_level: str = "INFO"
    update_rate_hz: int = 10


class AppConfig(BaseModel):
    general: GeneralConfig = Field(default_factory=GeneralConfig)
    i2c: I2CConfig = Field(default_factory=I2CConfig)
    motors: MotorsConfig
    safety: SafetyConfig = Field(default_factory=SafetyConfig)
    sdr: SDRConfig = Field(default_factory=SDRConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)


def load_config(path: Path | str = "config.toml") -> AppConfig:
    path = Path(path)
    with path.open("rb") as f:
        raw = tomllib.load(f)
    return AppConfig.model_validate(raw)
