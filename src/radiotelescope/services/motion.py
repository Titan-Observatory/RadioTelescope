from __future__ import annotations

import logging

from radiotelescope.hardware.motor import IBT2Motor
from radiotelescope.models.commands import MoveCommand, StopCommand
from radiotelescope.models.state import MotorState
from radiotelescope.safety.interlocks import SafetyMonitor

logger = logging.getLogger(__name__)


class MotionService:
    def __init__(
        self,
        motors: dict[str, IBT2Motor],
        safety: SafetyMonitor,
    ) -> None:
        self._motors = motors
        self._safety = safety

    def move(self, cmd: MoveCommand) -> MotorState:
        if self._safety.status.overcurrent_tripped:
            raise RuntimeError("Cannot move — overcurrent trip active. Reset safety first.")

        if not self._safety.check_limits(cmd.axis):
            raise ValueError(f"Move rejected by safety limits for axis {cmd.axis}")

        motor = self._motors[cmd.axis]
        motor.set_speed(cmd.speed, cmd.direction)
        return self._motor_state(cmd.axis, motor)

    def stop(self, cmd: StopCommand) -> dict[str, MotorState]:
        axes = [cmd.axis] if cmd.axis else list(self._motors.keys())
        result = {}
        for axis in axes:
            self._motors[axis].stop()
            result[axis] = self._motor_state(axis, self._motors[axis])
        return result

    def get_state(self) -> dict[str, MotorState]:
        return {
            axis: self._motor_state(axis, motor)
            for axis, motor in self._motors.items()
        }

    @staticmethod
    def _motor_state(axis: str, motor: IBT2Motor) -> MotorState:
        return MotorState(
            axis=axis,
            duty=motor.duty,
            direction=motor.direction,
            is_moving=motor.is_moving,
        )
