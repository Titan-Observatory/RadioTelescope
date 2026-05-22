import pytest

from rt_platform.config import load_config, public_exposure_errors


def test_load_config_substitutes_env_vars(tmp_path, monkeypatch):
    monkeypatch.setenv("RT_QUEUE_COOKIE_SECRET", "from-env-not-from-toml-abcdef")
    path = tmp_path / "config.toml"
    path.write_text(
        """
[queue]
enabled = true
cookie_secret = "${RT_QUEUE_COOKIE_SECRET}"
""",
        encoding="utf-8",
    )

    cfg = load_config(path)
    assert cfg.queue.cookie_secret == "from-env-not-from-toml-abcdef"


def test_load_config_env_var_default_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("RT_OPTIONAL_THING", raising=False)
    path = tmp_path / "config.toml"
    path.write_text(
        """
[queue]
enabled = true
cookie_secret = "${RT_OPTIONAL_THING:-fallback-secret-1234}"
""",
        encoding="utf-8",
    )

    cfg = load_config(path)
    assert cfg.queue.cookie_secret == "fallback-secret-1234"


def test_load_config_missing_env_var_without_default_raises(tmp_path, monkeypatch):
    monkeypatch.delenv("RT_NEVER_SET", raising=False)
    path = tmp_path / "config.toml"
    path.write_text(
        """
[queue]
enabled = true
cookie_secret = "${RT_NEVER_SET}"
""",
        encoding="utf-8",
    )

    with pytest.raises(KeyError, match="RT_NEVER_SET"):
        load_config(path)


def test_hardware_url_overridable_via_env(tmp_path, monkeypatch):
    monkeypatch.setenv("HARDWARE_URL", "http://example:1234")
    path = tmp_path / "config.toml"
    path.write_text("", encoding="utf-8")  # all defaults
    cfg = load_config(path)
    assert cfg.hardware_url == "http://example:1234"


def test_public_exposure_errors_on_placeholder_secrets(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        """
[server]
host = "0.0.0.0"
cors_origins = ["*"]
""",
        encoding="utf-8",
    )
    cfg = load_config(path)
    errors = public_exposure_errors(cfg)
    assert any("cookie_secret" in e for e in errors)
    assert any("cors_origins" in e for e in errors)


def test_public_exposure_silent_when_lan_only(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        """
[server]
host = "0.0.0.0"
lan_only = true
""",
        encoding="utf-8",
    )
    cfg = load_config(path)
    assert public_exposure_errors(cfg) == []
