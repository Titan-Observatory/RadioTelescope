from unittest.mock import MagicMock

from radiotelescope.hardware.motor import IBT2Motor, PWM_RANGE


def test_stop_zeros_both_pins(mock_motor: IBT2Motor, mock_pi: MagicMock):
    mock_motor.stop()
    calls = mock_pi.set_PWM_dutycycle.call_args_list
    # Last two calls should set both pins to 0
    last_two = calls[-2:]
    duties = {(c.args[0], c.args[1]) for c in last_two}
    assert (5, 0) in duties
    assert (6, 0) in duties


def test_set_speed_clamps_to_max_duty(mock_motor: IBT2Motor, mock_pi: MagicMock):
    mock_pi.reset_mock()
    mock_motor.set_speed(100, "forward")
    # max_duty is 80, so effective duty = 80
    assert mock_motor.duty == 80
    expected_hw = int(PWM_RANGE * 80 / 100)
    mock_pi.set_PWM_dutycycle.assert_any_call(5, expected_hw)  # RPWM
    mock_pi.set_PWM_dutycycle.assert_any_call(6, 0)  # LPWM zeroed


def test_reverse_direction(mock_motor: IBT2Motor, mock_pi: MagicMock):
    mock_pi.reset_mock()
    mock_motor.set_speed(50, "reverse")
    assert mock_motor.direction == "reverse"
    expected_hw = int(PWM_RANGE * 50 / 100)
    mock_pi.set_PWM_dutycycle.assert_any_call(6, expected_hw)  # LPWM
    mock_pi.set_PWM_dutycycle.assert_any_call(5, 0)  # RPWM zeroed


def test_is_moving(mock_motor: IBT2Motor):
    assert not mock_motor.is_moving
    mock_motor.set_speed(30, "forward")
    assert mock_motor.is_moving
    mock_motor.stop()
    assert not mock_motor.is_moving
