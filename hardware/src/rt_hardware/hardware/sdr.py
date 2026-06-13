"""LNA bias-tee controller for an inline LNA powered through the SDR.

After the spectrum DSP moved into a GNU Radio subprocess
([rt_hardware.sdr_pipeline]), this module's only remaining job is toggling
the SDR's antenna-port bias voltage. The tool depends on the configured
driver: ``airspy_gpio`` flips the Airspy's +4.5 V line, ``rtl_biast`` flips
the bias tee on RTL-SDR dongles (e.g. the Nooelec NESDR SMArTee). The
bias-tee path is kept separate from the DSP subprocess on purpose: the
operator should be able to flip the LNA on/off while the flowgraph is
running (or stopped) without bouncing either.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess

from rt_hardware.config import SDRConfig
from rt_hardware.models.state import LnaStatus

logger = logging.getLogger(__name__)

# Airspy: pin 13 on port 1 is the bias-tee enable line. The trailing value
# (0/1) is appended at call time.
_AIRSPY_BIAS_GPIO_CMD = ("airspy_gpio", "-p", "1", "-n", "13", "-w")
# RTL-SDR (rtl-sdr-blog tools): `rtl_biast -b 0|1`.
_RTLSDR_BIAS_CMD = ("rtl_biast", "-b")


def _bias_command(driver: str, value: str) -> tuple[str, ...]:
    """Build the bias-tee toggle command for the configured driver."""
    if driver == "rtlsdr":
        return (*_RTLSDR_BIAS_CMD, value)
    return (*_AIRSPY_BIAS_GPIO_CMD, value)


class LnaController:
    """Wraps the bias-tee toggle subprocess so route handlers stay simple."""

    def __init__(self, cfg: SDRConfig) -> None:
        self._cfg = cfg
        self._status = LnaStatus(
            state="on" if cfg.lna_bias_tee_enabled else "off",
            label="On" if cfg.lna_bias_tee_enabled else "Off",
            detail="Initial state from config (not yet applied to hardware)",
        )

    @property
    def status(self) -> LnaStatus:
        return self._status

    async def set(self, enabled: bool) -> LnaStatus:
        return await asyncio.to_thread(self._set_blocking, enabled)

    def _set_blocking(self, enabled: bool) -> LnaStatus:
        value = "1" if enabled else "0"
        cmd = _bias_command(self._cfg.driver, value)
        tool = cmd[0]
        try:
            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except FileNotFoundError as exc:
            self._status = LnaStatus(state="fault", label="Issue", detail=f"{tool} command not found")
            raise RuntimeError(self._status.detail) from exc
        except subprocess.TimeoutExpired as exc:
            self._status = LnaStatus(state="fault", label="Issue", detail=f"{tool} timed out")
            raise RuntimeError(self._status.detail) from exc

        if result.returncode != 0:
            detail = (result.stderr or result.stdout or f"{tool} exited with {result.returncode}").strip()
            self._status = LnaStatus(state="fault", label="Issue", detail=f"SDR bias tee failed: {detail}")
            raise RuntimeError(self._status.detail)

        self._cfg.lna_bias_tee_enabled = enabled
        self._status = (
            LnaStatus(state="on", label="On", detail="SDR bias tee enabled")
            if enabled
            else LnaStatus(state="off", label="Off", detail="SDR bias tee disabled")
        )
        return self._status


__all__ = ("LnaController",)
