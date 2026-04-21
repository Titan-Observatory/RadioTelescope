from __future__ import annotations

import asyncio
import base64
import logging
import time
from collections import deque

import numpy as np
from pydantic import BaseModel

from radiotelescope.config import SDRConfig
from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.models.commands import SDRTuneCommand

logger = logging.getLogger(__name__)

_PUBLISH_INTERVAL_S = 0.1  # 10 Hz output regardless of internal FFT rate


class SpectrumFrame(BaseModel):
    center_freq_hz: int
    bandwidth_hz: int
    fft_size: int
    magnitudes_b64: str
    rolling_b64: str
    timestamp: float
    integration_s: float
    frame_count: int


class _RollingBuffer:
    """O(1) rolling average of linear-power FFT frames, evicted by wall-clock age."""

    def __init__(self, window_s: float) -> None:
        self._window_s = window_s
        self._buf: deque[tuple[float, np.ndarray]] = deque()
        self._sum: np.ndarray | None = None

    def push(self, linear_power: np.ndarray, ts: float) -> tuple[np.ndarray, float, int]:
        """Add a frame, evict stale frames, return (rolling_db, integration_s, frame_count)."""
        if self._sum is None:
            self._sum = np.zeros_like(linear_power)

        # Evict frames older than the window
        cutoff = ts - self._window_s
        while self._buf and self._buf[0][0] < cutoff:
            old_ts, old_frame = self._buf.popleft()
            self._sum -= old_frame

        self._buf.append((ts, linear_power.copy()))
        self._sum += linear_power

        count = len(self._buf)
        integration_s = (ts - self._buf[0][0]) if count > 1 else 0.0
        rolling_db = 10.0 * np.log10(self._sum / count + 1e-12)
        return rolling_db, integration_s, count

    def reset(self) -> None:
        self._buf.clear()
        self._sum = None


class SpectrumService:
    def __init__(self, sdr: SDRReceiver, config: SDRConfig) -> None:
        self._sdr = sdr
        self._cfg = config
        self._subscribers: list[asyncio.Queue[SpectrumFrame]] = []
        self._task: asyncio.Task | None = None
        self._rolling = _RollingBuffer(window_s=30.0)
        self._rolling_window_s: float = 30.0

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    def set_rolling_window(self, window_s: float) -> None:
        self._rolling_window_s = window_s
        self._rolling = _RollingBuffer(window_s=window_s)

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[SpectrumFrame]:
        q: asyncio.Queue[SpectrumFrame] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[SpectrumFrame]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def start(self) -> None:
        if self.is_running:
            return
        self._rolling = _RollingBuffer(window_s=self._rolling_window_s)
        await self._sdr.open()
        self._task = asyncio.create_task(self._stream_loop())
        logger.info("Spectrum service started")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._sdr.close()
        logger.info("Spectrum service stopped")

    async def tune(self, cmd: SDRTuneCommand) -> None:
        await self._sdr.tune(freq=cmd.center_freq_hz, gain=cmd.gain)
        if cmd.center_freq_hz is not None:
            self._cfg.center_freq_hz = cmd.center_freq_hz
        if cmd.sample_rate_hz is not None:
            self._cfg.sample_rate_hz = cmd.sample_rate_hz

    def _encode(self, arr: np.ndarray) -> str:
        return base64.b64encode(arr.astype(np.float32).tobytes()).decode()

    async def _stream_loop(self) -> None:
        fft_size = self._cfg.fft_size
        n_avg = self._cfg.integration_count
        window = np.hanning(fft_size)
        last_publish = 0.0

        async for samples in self._sdr.stream_samples(fft_size * n_avg):
            acc = np.zeros(fft_size)
            for i in range(n_avg):
                chunk = samples[i * fft_size : (i + 1) * fft_size]
                if len(chunk) < fft_size:
                    break
                spectrum = np.fft.fftshift(np.fft.fft(chunk * window))
                acc += np.abs(spectrum) ** 2

            linear_power = acc / n_avg
            psd_db = 10.0 * np.log10(linear_power + 1e-12)

            now = time.time()
            rolling_db, integration_s, frame_count = self._rolling.push(linear_power, now)

            if now - last_publish < _PUBLISH_INTERVAL_S:
                continue
            last_publish = now

            frame = SpectrumFrame(
                center_freq_hz=self._cfg.center_freq_hz,
                bandwidth_hz=self._cfg.sample_rate_hz,
                fft_size=fft_size,
                magnitudes_b64=self._encode(psd_db),
                rolling_b64=self._encode(rolling_db),
                timestamp=now,
                integration_s=integration_s,
                frame_count=frame_count,
            )

            for q in list(self._subscribers):
                try:
                    q.put_nowait(frame)
                except asyncio.QueueFull:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    q.put_nowait(frame)
