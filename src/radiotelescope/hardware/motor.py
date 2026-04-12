from __future__ import annotations

import asyncio
import logging

import lgpio

from radiotelescope.config import MotorConfig

logger = logging.getLogger(__name__)

PWM_FREQUENCY = 1_000  # 1 kHz — within lgpio software PWM limits
_RAMP_STEP = 5          # duty % per step

# Interval between steps, derived at runtime from config:
#   interval = _RAMP_STEP * ramp_time_s / 100
#
# This gives a constant duty/second rate so that ramp duration scales
# linearly with distance.  ramp_time_s is defined as the time to travel
# the full 0→100 % range (or 100→0 for ramp_stop).  Stopping from 60 %
# therefore takes 60 % of ramp_time_s, not the full value.


class IBT2Motor:
    """Controls a single IBT-2 / BTS7960 H-bridge motor driver.

    RPWM drives forward, LPWM drives reverse.  Enable pins are assumed
    hardwired high.  Duty is clamped to ``config.max_duty``.

    Use ``stop()`` for immediate shutdown (emergencies, cleanup).
    Use ``ramp_stop()`` for normal commanded stops to manage momentum.

    ``config.ramp_time_s`` defines the time to sweep the full 0–100 % duty
    range.  Partial sweeps (including ramp_stop from below 100 %) take
    proportionally less time.
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

    @property
    def _step_interval(self) -> float:
        """Seconds between each _RAMP_STEP increment at the configured ramp rate."""
        return _RAMP_STEP * self._cfg.ramp_time_s / 100

    async def set_speed(self, duty: int, direction: str) -> None:
        """Ramp to target duty at a constant rate (config.ramp_time_s for 0→100 %).

        Cannot be bypassed — the only public API for commanding motion.
        Direction changes trigger a hard stop before ramping in the new direction
        to prevent H-bridge shoot-through.  Ramp down to a lower speed is
        handled the same way as ramp up.
        """
        clamped = max(0, min(duty, self._cfg.max_duty))

        if direction not in ("forward", "reverse"):
            await self.ramp_stop()
            return

        if self._direction not in ("stopped", direction):
            # Direction reversal: hard stop before switching sides
            self.stop()

        if clamped == 0:
            await self.ramp_stop()
            return

        self._direction = direction
        current = self._duty
        interval = self._step_interval

        logger.info(
            "Motor GPIO%d/%d: ramping to %s @ %d%% (%.1f %%/s)",
            self._rpwm, self._lpwm, direction, clamped,
            100 / self._cfg.ramp_time_s,
        )

        if current < clamped:
            while current < clamped:
                current = min(clamped, current + _RAMP_STEP)
                self._apply_duty(current)
                self._duty = current
                if current < clamped:
                    await asyncio.sleep(interval)
        elif current > clamped:
            while current > clamped:
                current = max(clamped, current - _RAMP_STEP)
                self._apply_duty(current)
                self._duty = current
                if current > clamped:
                    await asyncio.sleep(interval)

    def stop(self) -> None:
        """Immediate hard stop. Use for emergencies and cleanup only."""
        lgpio.tx_pwm(self._handle, self._rpwm, PWM_FREQUENCY, 0)
        lgpio.tx_pwm(self._handle, self._lpwm, PWM_FREQUENCY, 0)
        self._duty = 0
        self._direction = "stopped"

    async def ramp_stop(self) -> None:
        """Gradually reduce duty to zero at the configured ramp rate.

        Time to stop = (current_duty / 100) * ramp_time_s.  A motor running
        at 60 % stops in 60 % of ramp_time_s, not the full value.
        Direction is preserved until duty reaches zero.
        """
        current = self._duty
        if current == 0:
            return

        interval = self._step_interval

        logger.info(
            "Motor GPIO%d/%d: ramping down from %d%% (%.1fs to stop from 100%%)",
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
