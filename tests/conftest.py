from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def simulated_config_path(tmp_path: Path) -> Path:
    path = tmp_path / "config.toml"
    path.write_text(
        """
[general]
log_level = "DEBUG"

[roboclaw]
port = "SIM"
baudrate = 38400
address = 128
timeout_s = 0.1
connect_mode = "simulated"

[telemetry]
update_rate_hz = 5

[server]
host = "127.0.0.1"
port = 8000
cors_origins = ["*"]
""",
        encoding="utf-8",
    )
    return path
