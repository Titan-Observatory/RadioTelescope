"""goestools glue tests: nanomsg client, config generation, link aggregation.

A small asyncio fake of goesrecv's nanomsg PUB endpoint (SP-over-TCP:
8-byte handshake, uint64-BE length-prefixed messages) exercises the real
subscriber, so the wire protocol is covered without a goestools install.
"""
from __future__ import annotations

import asyncio
import json
import tomllib
from pathlib import Path

import pytest

from rt_hardware.config import GoesConfig
from rt_hardware.goes.goestools import (
    goesproc_command,
    goesrecv_command,
    render_goesrecv_config,
    resolve_goesproc_config,
)
from rt_hardware.goes.nanomsg import NanomsgProtocolError, NanomsgSubscriber
from rt_hardware.services.goes import _LinkState, estimate_snr_db

import numpy as np

_PUB_HELLO = bytes((0x00, 0x53, 0x50, 0x00, 0x00, 0x20, 0x00, 0x00))
_SUB_HELLO = bytes((0x00, 0x53, 0x50, 0x00, 0x00, 0x21, 0x00, 0x00))


async def _fake_pub_server(messages: list[bytes], *, bad_hello: bool = False):
    """One-shot nanomsg PUB endpoint: handshake, publish, close."""
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        hello = await reader.readexactly(len(_SUB_HELLO))
        assert hello == _SUB_HELLO
        writer.write(b"\xde\xad\xbe\xef\x00\x00\x00\x00" if bad_hello else _PUB_HELLO)
        for msg in messages:
            writer.write(len(msg).to_bytes(8, "big") + msg)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, port


async def test_nanomsg_subscriber_receives_framed_messages():
    messages = [b'{"gain": 12.5}\n', b"\x01" * 892, b""]
    server, port = await _fake_pub_server(messages)
    async with server:
        async with NanomsgSubscriber(f"tcp://127.0.0.1:{port}") as sub:
            assert await sub.recv() == messages[0]
            assert await sub.recv() == messages[1]
            assert await sub.recv() == b""
            with pytest.raises(asyncio.IncompleteReadError):
                await sub.recv()


async def test_nanomsg_subscriber_rejects_bad_handshake():
    server, port = await _fake_pub_server([], bad_hello=True)
    async with server:
        sub = NanomsgSubscriber(f"tcp://127.0.0.1:{port}")
        with pytest.raises(NanomsgProtocolError):
            await sub.connect()
        await sub.close()


# ─── goesrecv config generation ────────────────────────────────────────────


def test_generated_goesrecv_config_is_valid_toml_with_matching_endpoints():
    cfg = GoesConfig(mode="hrit", gain_db=21, lna_bias_tee_enabled=True)
    parsed = tomllib.loads(render_goesrecv_config(cfg))

    assert parsed["demodulator"]["mode"] == "hrit"
    assert parsed["demodulator"]["source"] == "airspy"
    assert parsed["airspy"]["frequency"] == 1_694_100_000
    assert parsed["airspy"]["sample_rate"] == 3_000_000
    assert parsed["airspy"]["gain"] == 21
    assert parsed["airspy"]["bias_tee"] is True
    assert parsed["decoder"]["packet_publisher"]["bind"] == f"tcp://127.0.0.1:{cfg.packet_port}"
    assert parsed["demodulator"]["stats_publisher"]["bind"] == f"tcp://127.0.0.1:{cfg.demod_stats_port}"
    assert parsed["decoder"]["stats_publisher"]["bind"] == f"tcp://127.0.0.1:{cfg.decoder_stats_port}"
    assert parsed["clock_recovery"]["sample_publisher"]["bind"] == f"tcp://127.0.0.1:{cfg.symbol_port}"


def test_lrit_mode_flows_into_config_and_symbol_rate():
    cfg = GoesConfig(mode="lrit", sdr="rtlsdr")
    parsed = tomllib.loads(render_goesrecv_config(cfg))
    assert parsed["demodulator"]["mode"] == "lrit"
    assert parsed["demodulator"]["source"] == "rtlsdr"
    assert "rtlsdr" in parsed
    assert cfg.symbol_rate_baud == pytest.approx(293_883)


def test_goesproc_fallback_config_materialises(tmp_path: Path):
    cfg = GoesConfig()
    path = resolve_goesproc_config(cfg, tmp_path)
    # No system goestools install in CI → the shipped fallback is used.
    if path.parent == tmp_path:
        handlers = tomllib.loads(path.read_text())["handler"]
        assert any(h["type"] == "image" for h in handlers)
        assert any(h["type"] == "emwin" for h in handlers)
        # Output dirs must be cwd-relative — goesproc runs in the product store.
        assert all(h["directory"].startswith("./") for h in handlers)


def test_goesproc_config_override_wins(tmp_path: Path):
    override = tmp_path / "custom.conf"
    override.write_text("[[handler]]\ntype = \"image\"\ndirectory = \"./x\"\n")
    cfg = GoesConfig(goesproc_config=str(override))
    assert resolve_goesproc_config(cfg, tmp_path) == override


def test_subprocess_commands():
    cfg = GoesConfig()
    assert goesrecv_command(cfg, Path("/state/goesrecv.conf"))[0] == "goesrecv"
    proc_cmd = goesproc_command(cfg, Path("/etc/goesproc.conf"))
    assert proc_cmd[:1] == ["goesproc"]
    assert "-m" in proc_cmd and "packet" in proc_cmd
    assert f"tcp://127.0.0.1:{cfg.packet_port}" in proc_cmd


# ─── Link-state aggregation ────────────────────────────────────────────────


def test_link_state_aggregates_goesrecv_observations():
    link = _LinkState()
    link.update_demod(json.loads(b'{"timestamp": "x", "gain": 14.2, "frequency": -812.5, "omega": 3.236}'))
    assert link.gain == 14.2
    assert link.freq_offset_hz == -812.5

    for n in range(10):
        link.update_decoder({"skipped_symbols": 0, "viterbi_errors": 100 + n, "reed_solomon_errors": 2, "ok": 1})
    link.update_decoder({"skipped_symbols": 5, "viterbi_errors": 900, "reed_solomon_errors": 0, "ok": 0})

    assert link.frames_total == 11
    assert link.frames_bad == 1
    assert link.rs_corrected == 20
    assert link.skipped_symbols == 5
    assert link.frame_lock  # an ok frame arrived just now

    for vcid in (1, 1, 2, 63):
        link.update_vcdu(vcid)
    assert link.vcdu_total == 4
    assert link.vcdu_fill == 1
    assert link.vcdu_counts == {1: 2, 2: 1}
    assert link.data_rate_kbps() > 0


def test_snr_estimator_separates_signal_from_noise():
    rng = np.random.default_rng(42)
    # Clean BPSK at ~10 dB Es/N0.
    sigma = float(np.sqrt(1.0 / (2.0 * 10.0)))
    bits = rng.choice((-1.0, 1.0), 4096)
    snr_signal = estimate_snr_db(bits + rng.normal(0, sigma, 4096), rng.normal(0, sigma, 4096))
    assert snr_signal == pytest.approx(10.0, abs=1.5)

    snr_noise = estimate_snr_db(rng.normal(0, 0.3, 4096), rng.normal(0, 0.3, 4096))
    assert snr_noise is not None and snr_noise < 0
