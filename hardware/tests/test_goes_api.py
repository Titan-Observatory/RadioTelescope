"""API + service tests for GOES mode (simulate backend, no hardware)."""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from rt_hardware.goes.encode import encode_file_to_cadus
from rt_hardware.goes.lrit import FILE_TYPE_TEXT
from rt_hardware.main import create_app


@pytest.fixture
def goes_config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from tests.fake_roboclaw import SimulatedRoboClaw

    monkeypatch.setattr("rt_hardware.main.make_client", lambda config: SimulatedRoboClaw(config))

    products_dir = tmp_path / "products"
    # Distinct filename: tests may use this fixture alongside
    # `simulated_config_path`, which also writes into tmp_path.
    path = tmp_path / "config-goes.toml"
    path.write_text(
        f"""
[general]
log_level = "DEBUG"

[roboclaw]
connect_mode = "auto"

[server]
host = "127.0.0.1"
port = 8001

[camera]
enabled = false

[observer]
latitude_deg = 38.9
longitude_deg = -77.0

[observation]
mode = "goes"

[goes]
simulate = true
products_dir = "{products_dir}"
""",
        encoding="utf-8",
    )
    return path


def test_observation_endpoint_reports_goes_mode_with_look_angles(goes_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        body = client.get("/api/observation").json()

    assert body["mode"] == "goes"
    assert body["downlink_freq_mhz"] == pytest.approx(1694.1)
    assert body["target_satellite_id"] == "goes-east"
    sats = {s["id"]: s for s in body["satellites"]}
    assert sats["goes-east"]["is_target"] is True
    # DC → GOES-East: high in the southern sky.
    assert 40.0 < sats["goes-east"]["elevation_deg"] < 48.0
    assert sats["goes-east"]["visible"] is True


def test_observation_endpoint_defaults_to_hydrogen_line(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        body = client.get("/api/observation").json()

    assert body["mode"] == "hydrogen_line"
    assert body["satellites"] == []


def test_modes_are_mutually_exclusive(goes_config_path, simulated_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        assert client.get("/api/goes/status").json()["enabled"] is True
        # Spectrum service is not instantiated in GOES mode.
        assert client.get("/api/spectrum/status").json()["mode"] == "disabled"

    with TestClient(create_app(simulated_config_path)) as client:
        assert client.get("/api/goes/status").json() == {"enabled": False, "mode": "disabled"}
        assert client.get("/api/spectrum/status").json()["enabled"] is True


def test_goes_status_snapshot_shape(goes_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        body = client.get("/api/goes/status").json()

    assert body["enabled"] is True
    assert body["mode"] == "idle"  # lazy: nothing spawned until a subscriber
    assert body["simulate"] is True
    assert body["symbol_rate_baud"] == 927_000
    assert body["products_total"] == 0


def test_goes_ws_streams_simulated_frames(goes_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        with client.websocket_connect("/ws/goes") as ws:
            frame = ws.receive_json()

    assert frame["stage"] in ("searching", "signal", "frames", "data")
    assert frame["snr_db"] is not None
    assert len(frame["psd_db"]) == 256
    assert len(frame["constellation"]) > 0
    assert frame["psd_center_mhz"] == pytest.approx(1694.1)


def test_products_endpoints_serve_decoded_files(goes_config_path):
    app = create_app(goes_config_path)
    with TestClient(app) as client:
        # Push a synthetic CADU stream straight through the service's decode
        # chain rather than waiting for the simulator's product timer.
        service = app.state.goes_service
        text = b"GOES BULLETIN\nDecode chain integration test.\n"
        service._decode_chunk(
            encode_file_to_cadus(0, 100, FILE_TYPE_TEXT, text, annotation="TEST_BULLETIN.lrit"),
        )

        listing = client.get("/api/goes/products").json()
        assert listing["total"] == 1
        product = listing["products"][0]
        assert product["kind"] == "text"
        assert product["name"] == "TEST_BULLETIN.lrit"
        assert "Decode chain" in product["preview"]

        meta = client.get(f"/api/goes/products/{product['id']}")
        assert meta.status_code == 200
        assert meta.json()["media_type"] == "text/plain"

        file_resp = client.get(f"/api/goes/products/{product['id']}/file")
        assert file_resp.status_code == 200
        assert file_resp.content == text

        cleared = client.delete("/api/goes/products").json()
        assert cleared == {"ok": True, "removed": 1}
        assert client.get("/api/goes/products").json()["total"] == 0
        assert client.get(f"/api/goes/products/{product['id']}").status_code == 404


def test_goes_endpoints_404_in_hydrogen_mode(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        assert client.get("/api/goes/products").status_code == 404
        assert client.post("/api/goes/reconnect").status_code == 404


def test_product_store_survives_restart(goes_config_path):
    app = create_app(goes_config_path)
    with TestClient(app) as client:
        app.state.goes_service._decode_chunk(
            encode_file_to_cadus(0, 100, FILE_TYPE_TEXT, b"persisted", annotation="KEEP.lrit"),
        )
        assert client.get("/api/goes/products").json()["total"] == 1

    app2 = create_app(goes_config_path)
    with TestClient(app2) as client:
        listing = client.get("/api/goes/products").json()
        assert listing["total"] == 1
        assert listing["products"][0]["name"] == "KEEP.lrit"


def test_simulator_locks_and_produces_products_when_pointed(goes_config_path):
    """Drive the simulator directly: pointed at the satellite, it should
    reach lock SNR; far off, it should stay near the noise floor."""
    from rt_hardware.config import load_config
    from rt_hardware.goes.simulator import GoesSimulator

    cfg = load_config(goes_config_path).goes

    on_target = GoesSimulator(cfg, pointing_error_deg=lambda: 0.05, beam_fwhm_deg=1.2)
    for _ in range(30):
        metrics = on_target.metrics()
    assert metrics["snr_db"] > cfg.snr_lock_db
    assert on_target.locked

    off_target = GoesSimulator(cfg, pointing_error_deg=lambda: 5.0, beam_fwhm_deg=1.2)
    for _ in range(30):
        metrics = off_target.metrics()
    assert metrics["snr_db"] < cfg.snr_lock_db
    assert not off_target.locked

    # Once locked, the simulator's data chunks decode into real products.
    on_target._next_product_at = 0.0
    chunk = on_target.data_chunk()
    assert len(chunk) > 0
