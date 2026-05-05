#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="roboclaw-controller"

cd "$ROOT_DIR"

git pull

cd "$ROOT_DIR/frontend"
npm install
npm run build

cd "$ROOT_DIR"
python -m pip install -e .

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  sudo systemctl restart "${SERVICE_NAME}.service"
  sudo systemctl status "${SERVICE_NAME}.service" --no-pager --lines=20
else
  echo "Built frontend and installed backend. No ${SERVICE_NAME}.service systemd unit found to restart."
fi
