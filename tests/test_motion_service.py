from unittest.mock import MagicMock

import pytest

from radiotelescope.models.commands import MoveCommand, StopCommand
from radiotelescope.models.state import SafetyStatus
from radiotelescope.services.motion import MotionService


@pytest.fixture
def motion_service(mock_motor, test_config, mock_handle):
    from radiotelescope.hardware.motor import IBT2Motor

    motors = {
        "azimuth": mock_motor,
        "elevation": IBT2Motor(test_config.motors.elevation, mock_handle),
    }
    safety = MagicMock()
    safety.current_monitor_available = True
    safety.status = SafetyStatus(overcurrent_tripped=False)
    safety.check_limits.return_value = True
    return MotionService(motors, safety)


async def test_move_forward(motion_service: MotionService):
    state = await motion_service.move(MoveCommand(axis="azimuth", speed=50, direction="forward"))
    assert state.is_moving
    assert state.direction == "forward"


async def test_stop_all(motion_service: MotionService):
    await motion_service.move(MoveCommand(axis="azimuth", speed=50, direction="forward"))
    result = await motion_service.stop(StopCommand())
    assert not result["azimuth"].is_moving
    assert not result["elevation"].is_moving


async def test_move_rejected_when_tripped(mock_motor, test_config, mock_handle):
    from radiotelescope.hardware.motor import IBT2Motor

    motors = {
        "azimuth": mock_motor,
        "elevation": IBT2Motor(test_config.motors.elevation, mock_handle),
    }
    safety = MagicMock()
    safety.current_monitor_available = True
    safety.status = SafetyStatus(overcurrent_tripped=True)
    svc = MotionService(motors, safety)

    with pytest.raises(RuntimeError, match="overcurrent"):
        await svc.move(MoveCommand(axis="azimuth", speed=50, direction="forward"))
