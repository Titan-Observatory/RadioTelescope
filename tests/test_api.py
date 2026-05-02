from __future__ import annotations

from fastapi.testclient import TestClient

from radiotelescope.main import create_app


def test_api_exposes_simulated_health(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["connection"]["mode"] == "simulated"


def test_api_command_registry_exposes_operator_commands_only(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        registry = client.get("/api/roboclaw/commands")
        result = client.post("/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}})

    command_ids = {command["id"] for command in registry.json()}
    assert registry.status_code == 200
    assert "forward_m1" in command_ids
    assert "set_m1_default_duty_accel" in command_ids
    assert "write_settings" not in command_ids
    assert "restore_defaults" not in command_ids
    assert result.status_code == 200
    assert result.json()["ok"] is True


def test_api_rejects_non_operator_command(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        accepted = client.post("/api/roboclaw/commands/write_settings", json={"args": {}})

    assert accepted.status_code == 404


def test_api_status_contains_telemetry(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/roboclaw/status")

    body = response.json()
    assert response.status_code == 200
    assert body["firmware"]
    assert "m1" in body["motors"]


def test_api_allows_configured_client(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            'allowed_clients = ["testclient"]',
            'allowed_clients = ["10.0.27.1", "10.0.27.2"]',
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path), client=("10.0.27.1", 50000)) as client:
        response = client.get("/api/health")

    assert response.status_code == 200


def test_api_rejects_unconfigured_client(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            'allowed_clients = ["testclient"]',
            'allowed_clients = ["10.0.27.1", "10.0.27.2"]',
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path), client=("10.0.27.3", 50000)) as client:
        response = client.get("/api/health")

    assert response.status_code == 403
    assert response.text == "Client IP not allowed"
