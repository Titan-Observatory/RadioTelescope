#!/usr/bin/env python3
"""Minimal dev CLI for hardware testing without starting the full server."""
import argparse
import asyncio
import time
import lgpio
from radiotelescope.config import load_config
from radiotelescope.hardware.motor import IBT2Motor
from radiotelescope.hardware.current_sensor import INA226


async def _move_async(args):
    cfg = load_config(args.config)
    handle = lgpio.gpiochip_open(0)
    motor_cfg = getattr(cfg.motors, args.axis)
    motor = IBT2Motor(motor_cfg, handle)
    try:
        print(f"Moving {args.axis} {args.direction} @ {args.speed}%")
        await motor.set_speed(args.speed, args.direction)
        await asyncio.sleep(args.duration)
        print("Ramping down...")
        await motor.ramp_stop()
    finally:
        motor.cleanup()
        lgpio.gpiochip_close(handle)


def cmd_move(args):
    asyncio.run(_move_async(args))

def cmd_read(args):
    cfg = load_config(args.config)
    sensor = INA226(cfg.i2c)
    try:
        for _ in range(args.count):
            r = sensor.read()
            if r.available:
                print(f"{r.bus_voltage_v:.3f}V  {r.current_a:.3f}A  {r.power_w:.3f}W")
            else:
                print("INA226 unavailable")
            time.sleep(0.5)
    finally:
        sensor.close()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("-c", "--config", default="config.toml")
    sub = p.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("move")
    m.add_argument("axis", choices=["azimuth", "elevation"])
    m.add_argument("direction", choices=["forward", "reverse"])
    m.add_argument("speed", type=int)
    m.add_argument("--duration", type=float, default=2.0)

    r = sub.add_parser("read")
    r.add_argument("--count", type=int, default=5)

    args = p.parse_args()
    {"move": cmd_move, "read": cmd_read}[args.cmd](args)

if __name__ == "__main__":
    main()
