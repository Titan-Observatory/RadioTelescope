"""The declarative proxy table (_proxy.ProxyRoute / register_proxy_routes).

Auth gating for table-registered routes is covered alongside the GOES proxy
tests; here we lock the forwarding mechanics that the table is responsible for:
the right method/path/timeout reach the hardware client, and forward_body rows
relay the request body (defaulting to {} when absent) while plain rows send no
body.
"""
from __future__ import annotations

from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from rt_platform.main import create_app


class _Recorder:
    """Stand-in for HardwareClient.request that captures the forwarded call."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, method, path, *, json=None, timeout=None):
        self.calls.append({"method": method, "path": path, "json": json, "timeout": timeout})
        return httpx.Response(200, json={"accepted": True})


def _control_client(config_path: Path) -> tuple[TestClient, _Recorder]:
    app = create_app(config_path)
    client = TestClient(app)
    client.__enter__()
    # Join with nobody waiting → immediate control, so control-gated rows pass.
    client.post("/api/queue/join", json={"turnstile_token": None, "beta_password": None})
    recorder = _Recorder()
    app.state.hardware_client.request = recorder
    return client, recorder


def test_table_forward_body_row_relays_json_and_timeout(platform_config_path: Path):
    client, recorder = _control_client(platform_config_path)
    try:
        resp = client.post("/api/telescope/jog/stop", json={"direction": "az"})
        assert resp.status_code == 200
        call = recorder.calls[-1]
        assert call["method"] == "POST"
        assert call["path"] == "/api/telescope/jog/stop"
        assert call["json"] == {"direction": "az"}  # forward_body=True relays it
        assert call["timeout"] == 10.0  # motor proxy's generous default
    finally:
        client.__exit__(None, None, None)


def test_table_forward_body_defaults_to_empty_dict(platform_config_path: Path):
    client, recorder = _control_client(platform_config_path)
    try:
        # No JSON body sent → mirror the old _safe_json behaviour ({}), not None.
        resp = client.post("/api/telescope/jog/stop")
        assert resp.status_code == 200
        assert recorder.calls[-1]["json"] == {}
    finally:
        client.__exit__(None, None, None)


def test_table_plain_row_sends_no_body_and_tight_timeout(platform_config_path: Path):
    client, recorder = _control_client(platform_config_path)
    try:
        resp = client.get("/api/roboclaw/status")
        assert resp.status_code == 200
        call = recorder.calls[-1]
        assert call["method"] == "GET"
        assert call["path"] == "/api/roboclaw/status"
        assert call["json"] is None  # plain row forwards no body
        assert call["timeout"] == 3.0  # read timeout preserved
    finally:
        client.__exit__(None, None, None)
