# Radio Telescope Controller

FastAPI backend with a developer web UI for controlling a Raspberry Pi radio telescope — dual-axis motor control (azimuth/elevation) via IBT-2/BTS7960 H-bridge drivers, INA226 current sensing over I2C, and RTL-SDR spectrum streaming.

## System requirements

Run these on the Raspberry Pi before installing the Python package:

```bash
# RTL-SDR native library — build from source (apt package is too old for pyrtlsdr)
sudo apt remove --purge librtlsdr-dev rtl-sdr   # remove old version if present
sudo apt install cmake libusb-1.0-0-dev
git clone https://github.com/rtlsdrblog/rtl-sdr-blog.git
cd rtl-sdr-blog && mkdir build && cd build
cmake .. -DINSTALL_UDEV_RULES=ON
make && sudo make install && sudo ldconfig
cd ../..
rm -rf rtl-sdr

# Enable I2C (for INA226 current sensor)
sudo raspi-config nonint do_i2c 0

# lgpio requires access to /dev/gpiochip0 — run as root or add udev rule:
sudo usermod -aG gpio $USER   # then log out and back in
```

GPIO and I2C are standard on Raspberry Pi OS; no extra packages needed beyond the above.

## Python install

```bash
python -m venv .env
source .env/bin/activate
pip install -e .
```

## Run

```bash
radiotelescope -c config.toml
```

Open the web UI at `http://<pi-ip>:8000/` from any machine on the same network.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Full telescope state |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/position` | Current motor states |
| `POST` | `/api/move` | Move a motor `{axis, speed, direction}` |
| `POST` | `/api/stop` | Stop motor(s) `{axis}` (null = all) |
| `POST` | `/api/safety/reset` | Clear overcurrent trip |
| `WS` | `/ws/telemetry` | 10 Hz telemetry stream |
| `WS` | `/ws/spectrum` | SDR spectrum frames |

## Hardware

| Component | Interface | Pins |
|-----------|-----------|------|
| IBT-2 motor driver (azimuth) | GPIO PWM | RPWM GPIO20, LPWM GPIO21 |
| IBT-2 motor driver (elevation) | GPIO PWM | RPWM GPIO5, LPWM GPIO6 |
| INA226 current sensor | I2C bus 1 | SDA GPIO2, SCL GPIO3 |
| RTL-SDR dongle | USB | — |
