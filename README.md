# Radio Telescope

A web-based control stack for a remotely operated radio telescope.

This project pairs a browser UI with telescope-side services for mount control,
live telemetry, spectrum viewing, and camera streaming. It is designed around a
public-facing platform service and a separate hardware service that stays on the
trusted telescope network.

## What It Does

- Provides a browser dashboard for observing and telescope control
- Supports queue-based access so multiple visitors can watch while one user has control
- Streams live mount telemetry, finder camera video, and SDR spectrum data
- Exposes operator tools for telescope status, queue management, and maintenance
- Keeps the hardware service isolated from the public internet

## Architecture

The repo is split into two main services:

- `platform/` - web app, API, queue, auth, admin tools, and proxy layer
- `hardware/` - mount, SDR, and camera control service

The browser talks to the platform. The platform talks to the hardware service
over HTTP and WebSockets.

```text
Browser -> Platform -> Hardware -> Telescope
```

## Quick Start

Copy the example configs and start the stack with Docker:

```bash
cp hardware/config.example.toml hardware/config.toml
cp platform/config.example.toml platform/config.toml
docker compose up
```

Then open:

```text
http://localhost:8000
```

For development without connected telescope hardware:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

## Hardware Service Setup

The hardware service usually runs on the machine attached to the telescope,
such as a Raspberry Pi or small Linux host. It controls the mount, receiver,
and camera, then exposes a local API for the platform service.

Install the OS packages needed by the SDR pipeline:

```bash
sudo apt update
sudo apt install \
  gnuradio gr-soapy python3-soapysdr python3-zmq \
  soapysdr-tools soapysdr-module-airspy soapysdr-module-rtlsdr \
  airspy rtl-sdr
```

Install and configure the service:

```bash
cd hardware
python -m venv .venv --system-site-packages
source .venv/bin/activate
pip install -e ".[dev]"
cp config.example.toml config.toml
```

Edit `config.toml` for your hardware:

- Set the RoboClaw serial port, usually `/dev/ttyACM0` or `/dev/ttyUSB0`.
- Set mount encoder scale and zero offsets before relying on goto commands.
- Set observer location and dish parameters.
- Choose the SDR driver, gain, sample rate, and bias tee setting.
- Choose the camera device if a finder camera is connected.

Give the runtime user access to the serial port:

```bash
sudo usermod -aG dialout $USER
```

Log out and back in after changing groups. Then start the service:

```bash
rt-hardware -c config.toml
```

By default it listens on port `8001`. Keep that port private to the telescope
network and point the platform's `hardware_url` at it.

For a production install, run it under systemd — see
`infra/systemd/rt-hardware.service`, which sets `RT_STATE_DIR` and the required
serial/USB groups for you.

## Local Development

Run the platform service:

```bash
cd platform
pip install -e ".[dev]"
cp config.example.toml config.toml
rt-platform -c config.toml
```

In another terminal, run the frontend dev server:

```bash
cd platform/frontend
npm install
npm run dev
```

## Configuration

Start from the example config files:

- `hardware/config.example.toml`
- `platform/config.example.toml`

The platform config points at the hardware service. The hardware config defines
the connected mount, receiver, observer location, and camera settings.

For public deployments, configure real secrets, CORS origins, authentication or
turnstile protection, and keep the hardware service private.

## API Reference

The browser-facing platform API and private hardware API are mapped in
[`docs/api.md`](docs/api.md). The platform is the public edge and applies queue,
control, auth, and LAN-admin gates before proxying trusted hardware routes.

## Testing

```bash
cd platform/frontend
npm run build

cd ../../hardware
pytest

cd ../platform
pytest
```

## Repository Layout

```text
hardware/                Telescope-side service
platform/                Web platform and frontend
docs/                    Project notes
infra/                   Deployment support
docker-compose.yml       Main Docker Compose stack
docker-compose.dev.yml   Development override
deploy.sh                Deployment helper
```

## Status

This is active observatory-control software. It is intended for real hardware,
but the development stack can run without attached devices.

Do not expose the hardware service directly to the internet.
