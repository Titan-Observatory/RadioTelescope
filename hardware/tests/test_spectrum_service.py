from __future__ import annotations

import asyncio
from typing import cast

import numpy as np
import pytest

from rt_hardware.config import SDRConfig
from rt_hardware.services._pubsub import Broadcaster
from rt_hardware.services.spectrum import SpectrumService


@pytest.mark.asyncio
async def test_reconnect_skips_when_internal_respawn_is_pending(tmp_path):
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)
    service._proc = None
    service._mode = "fault"

    async def pending_respawn():
        await asyncio.sleep(60)

    service._proc_task = asyncio.create_task(pending_respawn())
    try:
        mode = await service.reconnect()
    finally:
        service._proc_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await service._proc_task
        service._proc_task = None

    assert mode == "fault"
    assert service._proc is None


@pytest.mark.asyncio
async def test_relaunch_in_place_reuses_existing_process(tmp_path):
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)
    proc = object()
    service._proc = cast("subprocess.Popen[bytes]", proc)

    assert await service._relaunch_in_place() is proc


@pytest.mark.asyncio
async def test_ensure_running_skips_when_consumer_is_in_backoff(tmp_path):
    """A new subscribe while the consumer is mid-backoff must not spawn a
    second subprocess. Two Soapy sources fighting for the Airspy is the
    failure mode that manifested as ping-pong "no spectrum received within
    startup grace period" restarts in production.
    """
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)

    spawn_calls = 0

    async def fake_spawn():
        nonlocal spawn_calls
        spawn_calls += 1

    service._spawn_subprocess_locked = fake_spawn  # type: ignore[assignment]

    # Simulate the state right after _reap_dead_proc: subprocess is gone but
    # the consumer task is still alive, sleeping out its backoff before the
    # next _relaunch_in_place.
    service._proc = None

    async def pending_backoff():
        await asyncio.sleep(60)

    service._proc_task = asyncio.create_task(pending_backoff())
    try:
        await service._ensure_running()
    finally:
        service._proc_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await service._proc_task
        service._proc_task = None

    assert spawn_calls == 0
    assert service._proc is None


def test_publish_frame_does_not_send_linear_power_by_default(tmp_path):
    service = SpectrumService(
        SDRConfig(fft_size=64, publish_rate_hz=1.0, integration_seconds=3.0),
        tmp_path / "config.toml",
    )
    power = np.arange(1, 65, dtype=np.float32)

    service._integrated = power.copy()
    service._frames_seen = 1
    service._publish_frame()

    latest = service.latest
    assert latest is not None
    assert "power_linear" not in latest
    assert "corrected_db" not in latest
    assert latest["baseline_corrected"] is False
    assert np.median(latest["power_db"]) == pytest.approx(0.0, abs=1e-3)


@pytest.mark.asyncio
async def test_capture_baseline_uses_per_bin_median_linear_power(tmp_path, monkeypatch):
    from rt_hardware.services import spectrum as spectrum_module

    monkeypatch.setattr(spectrum_module, "BASELINE_CACHE", tmp_path / "baseline.json")
    service = SpectrumService(
        SDRConfig(fft_size=64, publish_rate_hz=1.0, integration_seconds=3.0),
        tmp_path / "config.toml",
    )
    base = np.arange(1, 65, dtype=np.float32)
    samples = [base, base * 10.0, base * 100.0]

    async def publish_samples():
        await asyncio.sleep(0)
        for seen, sample in enumerate(samples, start=1):
            service._integrated = sample.copy()
            service._frames_seen = seen
            service._publish_frame()
            await asyncio.sleep(0)

    publisher = asyncio.create_task(publish_samples())
    baseline = await service.capture_baseline()
    await publisher

    assert baseline is not None
    assert baseline["capture_samples"] == 3
    assert baseline["power_linear"] == pytest.approx((base * 10.0).tolist())
    assert baseline["power_db"] == pytest.approx((10.0 * np.log10(base * 10.0)).round(3).tolist())


@pytest.mark.asyncio
async def test_publish_frame_sends_only_calibrated_spectrum_when_baseline_is_active(tmp_path, monkeypatch):
    from rt_hardware.services import spectrum as spectrum_module

    monkeypatch.setattr(spectrum_module, "BASELINE_CACHE", tmp_path / "baseline.json")
    service = SpectrumService(
        SDRConfig(fft_size=64, publish_rate_hz=1.0, integration_seconds=3.0),
        tmp_path / "config.toml",
    )
    base = np.arange(1, 65, dtype=np.float32)
    async def publish_baseline_samples():
        await asyncio.sleep(0)
        for seen, sample in enumerate([base, base * 10.0, base * 100.0], start=1):
            service._integrated = sample.copy()
            service._frames_seen = seen
            service._publish_frame()
            await asyncio.sleep(0)

    publisher = asyncio.create_task(publish_baseline_samples())
    assert await service.capture_baseline() is not None
    await publisher

    service._integrated = base * 20.0
    service._frames_seen = 4
    service._publish_frame()

    latest = service.latest
    assert latest is not None
    assert "power_linear" not in latest
    assert "corrected_db" not in latest
    assert latest["baseline_corrected"] is True
    assert latest["power_db"] == pytest.approx(
        (10.0 * np.log10((base * 20.0) / (base * 10.0))).round(3).tolist()
    )
