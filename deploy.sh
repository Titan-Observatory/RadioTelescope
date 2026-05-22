#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

git pull

# Build both images and roll the stack. `up -d --build` is sufficient — it
# rebuilds changed images and recreates affected containers in place.
docker compose pull --ignore-pull-failures || true
docker compose up -d --build
docker compose ps
