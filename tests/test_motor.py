"""Motor ramp tests.

asyncio.sleep is patched to a no-op so ramp loops run instantly.
ramp_time_s = 2.0 in the test config, giving step_interval = 0.1 s — but
since sleep is mocked, only the duty arithmetic is exercised.
"""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from radiotelescope.hardware.motor import IBT2Motor, _RAMP_STEP


@pytest.fixture(autouse=True)
def instant_sleep():
    """Replace asyncio.sleep with an instant no-op for all motor tests."""
    with patch("radiotelescope.hardware.motor.asyncio.sleep", new_callable=AsyncMock):
        yield


# ---------------------------------------------------------------------------
# Hard stop
# ---------------------------------------------------------------------------


async def test_stop_zeros_duty(mock_motor: IBT2Motor):
    await mock_motor.set_speed(50, "forward")
    mock_motor.stop()
    assert mock_motor.duty == 0
    assert mock_motor.direction == "stopped"


# ---------------------------------------------------------------------------
# set_speed — ramp up
# ---------------------------------------------------------------------------


async def test_set_speed_clamps_to_max_duty(mock_motor: IBT2Motor):
    await mock_motor.set_speed(100, "forward")
    assert mock_motor.duty == mock_motor._cfg.max_duty  # 80


async def test_set_speed_reaches_target(mock_motor: IBT2Motor):
    await mock_motor.set_speed(40, "forward")
    assert mock_motor.duty == 40
    assert mock_motor.direction == "forward"


async def test_set_speed_ramps_down_to_lower_speed(mock_motor: IBT2Motor):
    await mock_motor.set_speed(60, "forward")
    assert mock_motor.duty == 60
    await mock_motor.set_speed(20, "forward")
    assert mock_motor.duty == 20
    assert mock_motor.direction == "forward"


# ---------------------------------------------------------------------------
# set_speed — direction changes
# ---------------------------------------------------------------------------


async def test_reverse_direction(mock_motor: IBT2Motor):
    await mock_motor.set_speed(50, "reverse")
    assert mock_motor.direction == "reverse"
    assert mock_motor.duty == 50


async def test_direction_change_hard_stops_first(mock_motor: IBT2Motor):
    """A direction reversal must zero duty before ramping the new way."""
    await mock_motor.set_speed(40, "forward")
    assert mock_motor.duty == 40

    # Intercept the hard stop so we can confirm it was called
    stopped_at = []
    original_stop = mock_motor.stop

    def recording_stop():
        stopped_at.append(mock_motor.duty)
        original_stop()

    mock_motor.stop = recording_stop
    await mock_motor.set_speed(30, "reverse")

    assert stopped_at, "stop() should have been called on direction change"
    assert mock_motor.direction == "reverse"
    assert mock_motor.duty == 30


# ---------------------------------------------------------------------------
# ramp_stop
# ---------------------------------------------------------------------------


async def test_ramp_stop_reaches_zero(mock_motor: IBT2Motor):
    await mock_motor.set_speed(60, "forward")
    await mock_motor.ramp_stop()
    assert mock_motor.duty == 0
    assert mock_motor.direction == "stopped"


async def test_ramp_stop_from_zero_is_noop(mock_motor: IBT2Motor):
    assert mock_motor.duty == 0
    await mock_motor.ramp_stop()  # should not raise
    assert mock_motor.duty == 0


# ---------------------------------------------------------------------------
# is_moving
# ---------------------------------------------------------------------------


async def test_is_moving(mock_motor: IBT2Motor):
    assert not mock_motor.is_moving
    await mock_motor.set_speed(30, "forward")
    assert mock_motor.is_moving
    mock_motor.stop()
    assert not mock_motor.is_moving


# ---------------------------------------------------------------------------
# Step-interval arithmetic
# ---------------------------------------------------------------------------


def test_step_interval_scales_with_ramp_time(mock_motor: IBT2Motor):
    """step_interval must equal _RAMP_STEP * ramp_time_s / 100."""
    expected = _RAMP_STEP * mock_motor._cfg.ramp_time_s / 100
    assert mock_motor._step_interval == pytest.approx(expected)
