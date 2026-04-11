from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class MoveCommand(BaseModel):
    axis: Literal["azimuth", "elevation"]
    speed: int = Field(ge=0, le=100, description="Duty cycle percentage")
    direction: Literal["forward", "reverse"]


class StopCommand(BaseModel):
    axis: Optional[Literal["azimuth", "elevation"]] = None


class SDRTuneCommand(BaseModel):
    center_freq_hz: Optional[int] = None
    sample_rate_hz: Optional[int] = None
    gain: Optional[str | float] = None
