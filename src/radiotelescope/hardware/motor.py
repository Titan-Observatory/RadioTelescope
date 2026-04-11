from __future__ import annotations

import logging

import pigpio

from radiotelescope.config import MotorConfig

logger = logging.getLogger(__name__)

PWM_FREQUENCY = 20_000
PWM_RANGE = 255


class IBT2Motor:
    """Controls a single IBT-2 / BTS7960 H-bridge motor driver.

    RPWM drives forward, LPWM drives reverse.  Enable pins are assumed
    hardwired high.  Duty is clamped to ``config.max_duty``.
    """

    def __init__(self, config: MotorConfig, pi: pigpio.pi) -> None:
        self._cfg = config
        self._pi = pi
        self._rpwm = config.rpwm_pin
        self._lpwm = config.lpwm_pin
        self._duty = 0
        self._direction = "stopped"

        self._pi.set_PWM_frequency(self._rpwm, PWM_FREQUENCY)
        self._pi.set_PWM_frequency(self._lpwm, PWM_FREQUENCY)
        self._pi.set_PWM_range(self._rpwm, PWM_RANGE)
        self._pi.set_PWM_range(self._lpwm, PWM_RANGE)
        self.stop()

    def set_speed(self, duty: int, direction: str) -> None:
        clamped = max(0, min(duty, self._cfg.max_duty))
        hw_duty = int(PWM_RANGE * clamped / 100)

        if direction == "forward":
            self._pi.set_PWM_dutycycle(self._lpwm, 0)
            self._pi.set_PWM_dutycycle(self._rpwm, hw_duty)
        elif direction == "reverse":
            self._pi.set_PWM_dutycycle(self._rpwm, 0)
            self._pi.set_PWM_dutycycle(self._lpwm, hw_duty)
        else:
            self.stop()
            return

        self._duty = clamped
        self._direction = direction
        logger.info("Motor GPIO%d/%d: %s @ %d%%", self._rpwm, self._lpwm, direction, clamped)

    def stop(self) -> None:
        self._pi.set_PWM_dutycycle(self._rpwm, 0)
        self._pi.set_PWM_dutycycle(self._lpwm, 0)
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
        self._pi.set_mode(self._rpwm, pigpio.INPUT)
        self._pi.set_mode(self._lpwm, pigpio.INPUT)
