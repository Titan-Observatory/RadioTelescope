from __future__ import annotations

import asyncio
import logging

import lgpio

from radiotelescope.config import MotorConfig

logger = logging.getLogger(__name__)

PWM_FREQUENCY = 1_000  # 1 kHz — within lgpio software PWM limits
_RAMP_STEP = 5          # duty % per step


class IBT2Motor:
    """Controls a single IBT-2 / BTS7960 H-bridge motor driver.

    RPWM drives forward, LPWM drives reverse.  Enable pins are assumed
    hardwired high.  Duty is clamped to ``config.max_duty``.

    Use ``stop()`` for immediate shutdown (emergencies, cleanup).
    Use ``ramp_stop()`` for normal commanded stops to manage momentum.
    """

    def __init__(self, config: MotorConfig, handle: int) -> None:
        self._cfg = config
        self._handle = handle
        self._rpwm = config.rpwm_pin
        self._lpwm = config.lpwm_pin
        self._duty = 0
        self._direction = "stopped"

        lgpio.gpio_claim_output(handle, self._rpwm)
        lgpio.gpio_claim_output(handle, self._lpwm)
        self.stop()

    def set_speed(self, duty: int, direction: str) -> None:
        clamped = max(0, min(duty, self._cfg.max_duty))

        if direction == "forward":
            lgpio.tx_pwm(self._handle, self._lpwm, PWM_FREQUENCY, 0)
            lgpio.tx_pwm(self._handle, self._rpwm, PWM_FREQUENCY, clamped)
        elif direction == "reverse":
            lgpio.tx_pwm(self._handle, self._rpwm, PWM_FREQUENCY, 0)
            lgpio.tx_pwm(self._handle, self._lpwm, PWM_FREQUENCY, clamped)
        else:
            self.stop()
            return

        self._duty = clamped
        self._direction = direction
        logger.info("Motor GPIO%d/%d: %s @ %d%%", self._rpwm, self._lpwm, direction, clamped)

    def stop(self) -> None:
        """Immediate hard stop. Use for emergencies and cleanup only."""
        lgpio.tx_pwm(self._handle, self._rpwm, PWM_FREQUENCY, 0)
        lgpio.tx_pwm(self._handle, self._lpwm, PWM_FREQUENCY, 0)
        self._duty = 0
        self._direction = "stopped"

    async def ramp_stop(self) -> None:
        """Gradually reduce duty to zero over a fixed duration to manage momentum.

        Always takes ``config.ramp_time_s`` seconds regardless of starting duty.
        Direction is preserved until duty reaches zero.
        """
        current = self._duty
        if current == 0:
            return

        steps = max(1, current // _RAMP_STEP)
        interval = self._cfg.ramp_time_s / steps  # seconds per step

        logger.info(
            "Motor GPIO%d/%d: ramping down from %d%% over %.1fs",
            self._rpwm, self._lpwm, current, self._cfg.ramp_time_s,
        )

        while current > 0:
            current = max(0, current - _RAMP_STEP)
            self._apply_duty(current)
            if current > 0:
                await asyncio.sleep(interval)

        self._duty = 0
        self._direction = "stopped"

    def _apply_duty(self, duty: int) -> None:
        if self._direction == "forward":
            lgpio.tx_pwm(self._handle, self._rpwm, PWM_FREQUENCY, duty)
        elif self._direction == "reverse":
            lgpio.tx_pwm(self._handle, self._lpwm, PWM_FREQUENCY, duty)

    @property
    def duty(self) -> int:
        return self._duty

    @property
    def direction(self) -> str:
        return self._direction

    @property
    def is_moving(self) -> bool:
        return self._duty > 0

    def cleanup(self) -> None:
        self.stop()
        lgpio.gpio_free(self._handle, self._rpwm)
        lgpio.gpio_free(self._handle, self._lpwm)
