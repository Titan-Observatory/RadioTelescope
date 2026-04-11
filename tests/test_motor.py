from radiotelescope.hardware.motor import IBT2Motor


def test_stop_zeros_duty(mock_motor: IBT2Motor):
    mock_motor.set_speed(50, "forward")
    mock_motor.stop()
    assert mock_motor.duty == 0
    assert mock_motor.direction == "stopped"


def test_set_speed_clamps_to_max_duty(mock_motor: IBT2Motor):
    mock_motor.set_speed(100, "forward")
    # max_duty is 80
    assert mock_motor.duty == 80


def test_reverse_direction(mock_motor: IBT2Motor):
    mock_motor.set_speed(50, "reverse")
    assert mock_motor.direction == "reverse"
    assert mock_motor.duty == 50


def test_is_moving(mock_motor: IBT2Motor):
    assert not mock_motor.is_moving
    mock_motor.set_speed(30, "forward")
    assert mock_motor.is_moving
    mock_motor.stop()
    assert not mock_motor.is_moving
