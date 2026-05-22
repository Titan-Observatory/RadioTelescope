# Radio Telescope

Two-service stack for controlling a RoboClaw-driven radio telescope with an Airspy SDR. The Raspberry Pi runs the **hardware** service (motors, SDR, camera); a web-facing **platform** service runs the React UI, the user queue, auth, and proxies all traffic to the hardware. They talk over HTTP/WebSocket.

```
┌──────────────┐         ┌────────────────────────┐         ┌──────────────┐
│  Browser     │ ◀────▶  │  platform  (port 8000) │ ◀────▶  │  hardware    │
│  (Vite SPA)  │   HTTP  │  - queue, auth, UI     │   HTTP  │  (port 8001) │
│              │   WS    │  - proxies to hardware │   WS    │  motors+SDR  │
└──────────────┘         └────────────────────────┘         └──────────────┘
```

## Quickstart — Docker (default)

```bash
git clone <repo>
cd radiotelescope
cp hardware/config.example.toml hardware/config.toml
cp platform/config.example.toml platform/config.toml
docker compose up
```

The UI is on `http://localhost:8000/`. The hardware service is **not** published — it is only reachable from the platform container over the internal bridge network.

For development on a machine without the RoboClaw / SDR plugged in:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This drops the `/dev/ttyACM0` USB pass-through, and the hardware service falls back to a disconnected (simulated) state.

## Quickstart — bare metal

In two terminals:

```bash
# Terminal 1 — hardware service (Pi, or any host with the RoboClaw plugged in)
cd hardware
pip install -e ".[dev]"
cp config.example.toml config.toml
rt-hardware -c config.toml

# Terminal 2 — platform service (any web-facing host on the LAN)
cd platform
pip install -e ".[dev]"
cp config.example.toml config.toml
# edit config.toml to set hardware_url = "http://<pi-ip>:8001"
rt-platform -c config.toml
```

For frontend dev with hot reload:

```bash
cd platform/frontend
npm install
npm run dev          # Vite on :5173, proxies /api → platform on :8000
```

## Pi serial-port access

```bash
sudo usermod -aG dialout $USER   # then log out and back in
```

## Internet exposure

The platform has a public-view / queued-control model: visitors may see the live dashboard, but mutating endpoints require the active queue lease. Operator endpoints (homing, sync) remain LAN-admin-only.

For an internet-facing deployment of the **platform** (the **hardware** service must never be exposed publicly):

- Run TLS at nginx / Caddy in front of the platform and forward `X-Forwarded-For` + `X-Forwarded-Proto`.
- Set `server.lan_only = false`, configure real `cors_origins`, generate a real `queue.cookie_secret`, and set production Turnstile keys (or enable `auth.enabled` with a real `secret_key`).
- `platform/main.py` runs `public_exposure_errors(cfg)` at startup and refuses to boot with placeholder secrets.

## Project layout

```
hardware/                Pi-side service: motors, SDR, camera
  src/rt_hardware/
  config.example.toml
  Dockerfile
  pyproject.toml

platform/                Web-facing service: UI, queue, auth, proxy
  src/rt_platform/
  frontend/              Vite + React + TS
  config.example.toml
  Dockerfile
  pyproject.toml

docker-compose.yml       Two-service stack (the default user experience)
docker-compose.dev.yml   Overrides for laptop / no-hardware dev
deploy.sh                git pull + docker compose up -d --build
docs/separation-plan.md  Rationale for the two-service split
```

See [CLAUDE.md](CLAUDE.md) for the deeper architecture notes.
