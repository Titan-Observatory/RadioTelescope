from __future__ import annotations

from typing import Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from radiotelescope.models.commands import SDRTuneCommand
from radiotelescope.services.session import require_session

router = APIRouter(prefix="/api/config", tags=["config"])


@router.get("")
async def get_config(request: Request):
    cfg = request.app.state.config
    return {
        "safety": cfg.safety.model_dump(),
        "sdr": cfg.sdr.model_dump(),
        "motors": {
            "azimuth": {
                "max_duty": cfg.motors.azimuth.max_duty,
                "ramp_time_s": cfg.motors.azimuth.ramp_time_s,
            },
            "elevation": {
                "max_duty": cfg.motors.elevation.max_duty,
                "ramp_time_s": cfg.motors.elevation.ramp_time_s,
            },
        },
    }


class _SafetyUpdate(BaseModel):
    overcurrent_threshold_a: Optional[float] = Field(None, gt=0)
    overcurrent_holdoff_s: Optional[float] = Field(None, ge=0)
    azimuth_min_deg: Optional[float] = None
    azimuth_max_deg: Optional[float] = None
    elevation_min_deg: Optional[float] = None
    elevation_max_deg: Optional[float] = None


@router.patch("/safety", dependencies=[Depends(require_session)])
async def patch_safety(body: _SafetyUpdate, request: Request):
    cfg = request.app.state.config.safety
    # SafetyMonitor holds a reference to the same config object, so changes take effect immediately
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(cfg, k, v)
    return cfg.model_dump()


class _SDRUpdate(BaseModel):
    center_freq_hz: Optional[int] = Field(None, gt=0)
    sample_rate_hz: Optional[int] = Field(None, gt=0)
    gain: Optional[Union[str, float]] = None
    fft_size: Optional[int] = Field(None, ge=64)
    integration_count: Optional[int] = Field(None, ge=1)


@router.patch("/sdr", dependencies=[Depends(require_session)])
async def patch_sdr(body: _SDRUpdate, request: Request):
    cfg = request.app.state.config.sdr
    svc = request.app.state.spectrum_service
    needs_restart = False

    for k, v in body.model_dump(exclude_none=True).items():
        setattr(cfg, k, v)
        if k in ("fft_size", "integration_count"):
            needs_restart = True

    # Retune live hardware for freq/gain/rate changes without restart
    if svc.is_running and (
        body.center_freq_hz is not None
        or body.gain is not None
        or body.sample_rate_hz is not None
    ):
        await svc.tune(
            SDRTuneCommand(
                center_freq_hz=body.center_freq_hz,
                gain=body.gain,
                sample_rate_hz=body.sample_rate_hz,
            )
        )

    result = cfg.model_dump()
    result["needs_restart"] = needs_restart
    return result


class _MotorUpdate(BaseModel):
    max_duty: Optional[int] = Field(None, ge=1, le=100)
    ramp_time_s: Optional[float] = Field(None, ge=0.1, le=30.0)


@router.patch("/motor/{axis}", dependencies=[Depends(require_session)])
async def patch_motor(axis: str, body: _MotorUpdate, request: Request):
    if axis not in ("azimuth", "elevation"):
        raise HTTPException(status_code=404, detail=f"Unknown axis: {axis}")
    # IBT2Motor holds a reference to this same config object; changes take effect immediately
    motor_cfg = getattr(request.app.state.config.motors, axis)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(motor_cfg, k, v)
    return {"axis": axis, "max_duty": motor_cfg.max_duty, "ramp_time_s": motor_cfg.ramp_time_s}
