from __future__ import annotations

import logging

import lgpio

from radiotelescope.config import MotorConfig

logger = logging.getLogger(__name__)

PWM_FREQUENCY = 20_000  # 20 kHz — inaudible, good for BTS7960


class IBT2Motor:
    """Controls a single IBT-2 / BTS7960 H-bridge motor driver.

    RPWM drives forward, LPWM drives reverse.  Enable pins are assumed
    hardwired high.  Duty is clamped to ``config.max_duty``.
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
            lgpio.tx_pwm(self._handle, self._lpwm, 0, 0)
            lgpio.tx_pwm(self._handle, self._rpwm, PWM_FREQUENCY, clamped)
        elif direction == "reverse":
            lgpio.tx_pwm(self._handle, self._rpwm, 0, 0)
            lgpio.tx_pwm(self._handle, self._lpwm, PWM_FREQUENCY, clamped)
        else:
            self.stop()
            return

        self._duty = clamped
        self._direction = direction
        logger.info("Motor GPIO%d/%d: %s @ %d%%", self._rpwm, self._lpwm, direction, clamped)

    def stop(self) -> None:
        lgpio.tx_pwm(self._handle, self._rpwm, 0, 0)
        lgpio.tx_pwm(self._handle, self._lpwm, 0, 0)
        self._duty = 0
        self._direction = "stopped"

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
