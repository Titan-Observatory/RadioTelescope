"""GOES downlink service, backed by goestools.

Supervises a `goesrecv` subprocess (SDR → BPSK demod → Viterbi →
Reed-Solomon → VCDUs) and a `goesproc` subprocess (VCDUs → product files on
disk), with the same lazy lifecycle SpectrumService uses: spawn on the first
WebSocket subscriber, idle-close after the last leaves, crash backoff with
reset. The service consumes goesrecv's nanomsg publishers —

* demodulator stats (JSON: gain, frequency, omega),
* decoder stats (JSON per frame: viterbi_errors, reed_solomon_errors, ok),
* post-clock-recovery symbols (int8 I/Q — constellation + SNR estimate),
* VCDU packets (892 B — per-virtual-channel counters + data rate)

— folds them into status frames broadcast to ``/ws/goes``, and indexes
goesproc's output directory into the ProductStore for the HTTP API.

``goes.simulate = true`` swaps both subprocesses for [GoesSimulator], which
produces the same observation shapes and writes demo products into the same
directory — everything downstream runs unchanged, no SDR or goestools
install required.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

import numpy as np

from rt_hardware.config import GoesConfig
from rt_hardware.goes.goestools import (
    goesproc_command,
    goesrecv_command,
    missing_binaries,
    resolve_goesproc_config,
    write_goesrecv_config,
)
from rt_hardware.goes.nanomsg import NanomsgSubscriber
from rt_hardware.goes.products import ProductStore
from rt_hardware.goes.simulator import GoesSimulator
from rt_hardware.services._pubsub import Broadcaster

_STATE_DIR = Path(os.environ.get("RT_STATE_DIR", "."))

VCDU_BYTES = 892
VCID_FILL = 63
# How recently an ok frame must have been decoded to count as frame lock.
_FRAME_LOCK_WINDOW_S = 3.0
_PRODUCT_SCAN_INTERVAL_S = 5.0
_NANOMSG_RETRY_S = 1.0
_CONSTELLATION_POINTS = 128

logger = logging.getLogger(__name__)


class GoesFrame(dict):
    """Plain dict so FastAPI's WebSocket can JSON-encode it cheaply."""


class _PipelineDied(RuntimeError):
    """A goestools subprocess exited or could not be started."""


def estimate_snr_db(i: np.ndarray, q: np.ndarray) -> float | None:
    """Es/N0 estimate from phase-locked BPSK symbols.

    With the carrier locked, symbols sit at ±A on the real axis and Q is
    pure noise: SNR ≈ A² / 2σ². Pure noise estimates to about -5 dB, well
    under any lock threshold.
    """
    if i.size < 16:
        return None
    amplitude = float(np.mean(np.abs(i)))
    noise_var = float(np.var(q))
    if noise_var <= 1e-9:
        return 25.0  # clipped/noise-free capture; cap rather than explode
    return min(25.0, float(10.0 * np.log10((amplitude * amplitude) / (2.0 * noise_var) + 1e-9)))


class _LinkState:
    """Aggregates pipeline observations into one status snapshot.

    Fed by the nanomsg consumers in goestools mode and by the simulator in
    simulate mode; reset on every pipeline (re)spawn.
    """

    def __init__(self) -> None:
        self.gain: float | None = None
        self.freq_offset_hz: float | None = None
        self.omega: float | None = None
        self.snr_db: float | None = None
        self.constellation: list[list[float]] = []
        self.frames_total = 0
        self.frames_bad = 0
        self.skipped_symbols = 0
        self.rs_corrected = 0
        self.viterbi_window: deque[int] = deque(maxlen=200)
        self.last_ok_frame_at: float | None = None
        self.vcdu_total = 0
        self.vcdu_fill = 0
        self.vcdu_counts: dict[int, int] = {}
        self.recent_bytes: deque[tuple[float, int]] = deque()

    def update_demod(self, stats: dict) -> None:
        if isinstance(stats.get("gain"), (int, float)):
            self.gain = round(float(stats["gain"]), 2)
        if isinstance(stats.get("frequency"), (int, float)):
            self.freq_offset_hz = round(float(stats["frequency"]), 1)
        if isinstance(stats.get("omega"), (int, float)):
            self.omega = float(stats["omega"])

    def update_decoder(self, stats: dict) -> None:
        self.frames_total += 1
        if not stats.get("ok"):
            self.frames_bad += 1
        else:
            self.last_ok_frame_at = time.monotonic()
        self.skipped_symbols += int(stats.get("skipped_symbols") or 0)
        self.rs_corrected += int(stats.get("reed_solomon_errors") or 0)
        self.viterbi_window.append(int(stats.get("viterbi_errors") or 0))

    def update_symbols(self, symbols: list[tuple[float, float]]) -> None:
        if not symbols:
            return
        arr = np.asarray(symbols, dtype=np.float64)
        self.snr_db = estimate_snr_db(arr[:, 0], arr[:, 1])
        if self.snr_db is not None:
            self.snr_db = round(self.snr_db, 2)
        step = max(1, len(symbols) // _CONSTELLATION_POINTS)
        self.constellation = [
            [round(float(i), 4), round(float(q), 4)] for i, q in symbols[::step][:_CONSTELLATION_POINTS]
        ]

    def update_vcdu(self, vcid: int) -> None:
        self.vcdu_total += 1
        if vcid == VCID_FILL:
            self.vcdu_fill += 1
        else:
            self.vcdu_counts[vcid] = self.vcdu_counts.get(vcid, 0) + 1
        self.recent_bytes.append((time.monotonic(), VCDU_BYTES))

    @property
    def frame_lock(self) -> bool:
        return (
            self.last_ok_frame_at is not None
            and time.monotonic() - self.last_ok_frame_at < _FRAME_LOCK_WINDOW_S
        )

    def viterbi_errors_avg(self) -> float | None:
        if not self.viterbi_window:
            return None
        return round(sum(self.viterbi_window) / len(self.viterbi_window), 1)

    def data_rate_kbps(self) -> float:
        now = time.monotonic()
        while self.recent_bytes and now - self.recent_bytes[0][0] > 10.0:
            self.recent_bytes.popleft()
        if not self.recent_bytes:
            return 0.0
        span = max(1.0, now - self.recent_bytes[0][0])
        return round(sum(n for _, n in self.recent_bytes) * 8.0 / span / 1000.0, 1)


class GoesService(Broadcaster[GoesFrame]):
    name: str = "goes-service"
    idle_close_delay_s: float = 30.0
    subprocess_kill_timeout_s: float = 3.0
    _backoff_schedule: tuple[float, ...] = (1.0, 2.0, 5.0, 15.0, 30.0)

    def __init__(
        self,
        cfg: GoesConfig,
        *,
        beam_fwhm_deg: float = 1.2,
        pointing_error_deg: Callable[[], float | None] | None = None,
    ) -> None:
        super().__init__()
        self._cfg = cfg
        self._beam_fwhm_deg = beam_fwhm_deg
        self._pointing_error_deg = pointing_error_deg
        products_dir = Path(cfg.products_dir)
        if not products_dir.is_absolute():
            products_dir = _STATE_DIR / products_dir
        self.products = ProductStore(products_dir, cfg.max_products)

        self._latest: GoesFrame | None = None
        self._link = _LinkState()
        self._procs: list[subprocess.Popen[bytes]] = []
        self._supervisor_task: asyncio.Task[None] | None = None
        self._idle_close_task: asyncio.Task[None] | None = None
        self._lifecycle_lock = asyncio.Lock()
        self._mode: str = "idle"
        self._fault_detail: str | None = None
        self._shutting_down: bool = False

    # ── Read-only properties ─────────────────────────────────────────

    @property
    def latest(self) -> GoesFrame | None:
        return self._latest

    @property
    def mode(self) -> str:
        if self._shutting_down:
            return "idle"
        return self._mode

    @property
    def fault_detail(self) -> str | None:
        return self._fault_detail

    def _pids(self) -> list[int]:
        return [p.pid for p in self._procs if p.poll() is None]

    def status_snapshot(self) -> dict[str, Any]:
        latest = self._latest
        return {
            "enabled": True,
            "mode": self.mode,
            "stage": latest.get("stage") if latest else "idle",
            "backend": "simulate" if self._cfg.simulate else "goestools",
            "simulate": self._cfg.simulate,
            "downlink_mode": self._cfg.mode,
            "downlink_freq_mhz": self._cfg.downlink_freq_hz / 1e6,
            "sample_rate_mhz": self._cfg.sample_rate_hz / 1e6,
            "symbol_rate_baud": self._cfg.symbol_rate_baud,
            "latest_timestamp": latest.get("timestamp") if latest else None,
            "subscriber_count": self.subscriber_count,
            "pipeline_pids": self._pids(),
            "fault_detail": self._fault_detail,
            "products_total": self.products.total,
        }

    # ── Lifecycle ────────────────────────────────────────────────────

    async def start(self) -> None:
        logger.info(
            "%s ready (lazy — %s spawns on first subscriber)",
            self.name, "simulator" if self._cfg.simulate else "goesrecv+goesproc",
        )

    async def stop(self) -> None:
        self._shutting_down = True
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            await self._stop_supervisor_locked()
        logger.info("%s stopped", self.name)

    async def reconnect(self) -> str:
        """Kill and respawn the goestools subprocesses (or simulator)."""
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            await self._stop_supervisor_locked()
            if self.subscriber_count > 0 and not self._shutting_down:
                self._start_supervisor_locked()
        logger.info("%s reconnected (mode=%s)", self.name, self._mode)
        return self.mode

    def subscribe(self, maxsize: int | None = None) -> asyncio.Queue[GoesFrame]:
        q = super().subscribe(maxsize)
        if self._latest is not None:
            q.put_nowait(self._latest)
        if not self._shutting_down:
            asyncio.create_task(self._ensure_running(), name=f"{self.name}-spawn")
        return q

    def unsubscribe(self, q: asyncio.Queue[GoesFrame]) -> None:
        super().unsubscribe(q)
        if self.subscriber_count == 0 and self._supervisor_task is not None and not self._shutting_down:
            if self._idle_close_task is None or self._idle_close_task.done():
                self._idle_close_task = asyncio.create_task(
                    self._close_after_idle(), name=f"{self.name}-idle-close",
                )

    async def _ensure_running(self) -> None:
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            if self._shutting_down or self.subscriber_count == 0:
                return
            if self._supervisor_task is not None and not self._supervisor_task.done():
                return
            self._start_supervisor_locked()

    def _start_supervisor_locked(self) -> None:
        runner = self._run_simulator if self._cfg.simulate else self._run_goestools
        self._mode = "starting"
        self._fault_detail = None
        self._supervisor_task = asyncio.create_task(self._supervise(runner), name=self.name)

    async def _stop_supervisor_locked(self) -> None:
        task = self._supervisor_task
        self._supervisor_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("%s supervisor raised during shutdown", self.name)
        await self._kill_subprocesses()
        self._mode = "idle"

    async def _close_after_idle(self) -> None:
        try:
            await asyncio.sleep(self.idle_close_delay_s)
        except asyncio.CancelledError:
            return
        async with self._lifecycle_lock:
            if self.subscriber_count > 0 or self._supervisor_task is None or self._shutting_down:
                return
            await self._stop_supervisor_locked()
            logger.info("%s closed pipeline (idle, no subscribers)", self.name)

    async def _cancel_idle_close(self) -> None:
        task = self._idle_close_task
        self._idle_close_task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # ── Supervisor: run, back off on crash, reset on a healthy run ────

    async def _supervise(self, runner: Callable[[], Any]) -> None:
        backoff_index = 0
        while not self._shutting_down and self.subscriber_count > 0:
            self._link = _LinkState()
            started = time.monotonic()
            try:
                await runner()
                return  # clean exit
            except asyncio.CancelledError:
                raise
            except _PipelineDied as exc:
                if self._mode != "unavailable":
                    self._mode = "fault"
                self._fault_detail = str(exc)
                logger.warning("%s pipeline died: %s", self.name, exc)
            except Exception as exc:
                self._mode = "fault"
                self._fault_detail = f"GOES consumer crashed: {exc}"
                logger.exception("%s crashed", self.name)
            finally:
                await self._kill_subprocesses()

            if time.monotonic() - started > 60.0:
                backoff_index = 0  # it ran for a while; treat the crash as fresh
            if self._shutting_down or self.subscriber_count == 0:
                return
            wait = self._backoff_schedule[min(backoff_index, len(self._backoff_schedule) - 1)]
            backoff_index += 1
            logger.info("%s respawning in %.1fs (attempt %d)", self.name, wait, backoff_index)
            await asyncio.sleep(wait)

    # ── Simulator backend ─────────────────────────────────────────────

    async def _run_simulator(self) -> None:
        sim = GoesSimulator(
            self._cfg, self.products.directory, self._pointing_error_deg, self._beam_fwhm_deg,
        )
        self._mode = "running"
        period = 1.0 / self._cfg.status_rate_hz
        last_scan = 0.0
        while not self._shutting_down and self.subscriber_count > 0:
            tick = await asyncio.to_thread(sim.tick)
            link = self._link
            link.update_demod(tick.demod_stats)
            for stats in tick.decoder_stats:
                link.update_decoder(stats)
            link.update_symbols(tick.symbols)
            for vcid in tick.vcids:
                link.update_vcdu(vcid)
            if time.monotonic() - last_scan > _PRODUCT_SCAN_INTERVAL_S:
                last_scan = time.monotonic()
                await asyncio.to_thread(self.products.scan)
            self._publish_frame()
            await asyncio.sleep(period)

    # ── goestools backend ─────────────────────────────────────────────

    async def _run_goestools(self) -> None:
        cfg = self._cfg
        missing = missing_binaries(cfg)
        if missing:
            self._mode = "unavailable"
            raise _PipelineDied(
                f"goestools binaries not found: {', '.join(missing)}. "
                "Install from https://github.com/pietern/goestools (or set goes.simulate = true).",
            )

        goesrecv_conf = write_goesrecv_config(cfg, _STATE_DIR)
        goesproc_conf = resolve_goesproc_config(cfg, _STATE_DIR)

        goesrecv = self._spawn(goesrecv_command(cfg, goesrecv_conf), "goesrecv")
        # goesproc resolves handler output dirs relative to its cwd — run it
        # inside the product store so files land where the API serves them.
        goesproc = self._spawn(goesproc_command(cfg, goesproc_conf), "goesproc", cwd=self.products.directory)
        self._mode = "starting"

        host = "127.0.0.1"
        tasks = [
            asyncio.create_task(self._pipe_output(goesrecv, "goesrecv"), name=f"{self.name}-goesrecv-log"),
            asyncio.create_task(self._pipe_output(goesproc, "goesproc"), name=f"{self.name}-goesproc-log"),
            asyncio.create_task(
                self._consume_json(f"tcp://{host}:{cfg.demod_stats_port}", self._on_demod_stats, goesrecv),
                name=f"{self.name}-demod-stats",
            ),
            asyncio.create_task(
                self._consume_json(f"tcp://{host}:{cfg.decoder_stats_port}", self._link.update_decoder, goesrecv),
                name=f"{self.name}-decoder-stats",
            ),
            asyncio.create_task(
                self._consume_symbols(f"tcp://{host}:{cfg.symbol_port}", goesrecv),
                name=f"{self.name}-symbols",
            ),
            asyncio.create_task(
                self._consume_packets(f"tcp://{host}:{cfg.packet_port}", goesrecv),
                name=f"{self.name}-packets",
            ),
            asyncio.create_task(self._status_loop(goesrecv, goesproc), name=f"{self.name}-status"),
        ]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in done:
                exc = task.exception()
                if exc is not None:
                    raise exc
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def _on_demod_stats(self, stats: dict) -> None:
        if self._mode != "running":
            self._mode = "running"
            self._fault_detail = None
        self._link.update_demod(stats)

    def _spawn(self, cmd: list[str], label: str, cwd: Path | None = None) -> subprocess.Popen[bytes]:
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(cwd) if cwd is not None else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            raise _PipelineDied(f"Could not exec {label} ({cmd[0]}): {exc}") from exc
        self._procs.append(proc)
        logger.info("%s spawned %s pid=%d", self.name, label, proc.pid)
        return proc

    async def _status_loop(self, *procs: subprocess.Popen[bytes]) -> None:
        period = 1.0 / self._cfg.status_rate_hz
        last_scan = 0.0
        while not self._shutting_down and self.subscriber_count > 0:
            for proc in procs:
                code = proc.poll()
                if code is not None:
                    raise _PipelineDied(f"subprocess {proc.args[0]} exited with code {code}")
            if time.monotonic() - last_scan > _PRODUCT_SCAN_INTERVAL_S:
                last_scan = time.monotonic()
                added = await asyncio.to_thread(self.products.scan)
                if added:
                    logger.info("%s indexed %d new product(s)", self.name, added)
            self._publish_frame()
            await asyncio.sleep(period)

    # ── nanomsg consumers ─────────────────────────────────────────────
    # goesrecv takes a moment to bind its publishers, and they all share its
    # fate — so consumers retry connecting for as long as the process lives
    # and treat a dropped connection as "wait for respawn/retry", leaving
    # death detection to the status loop.

    async def _consume_stream(self, url: str, proc: subprocess.Popen[bytes], on_message) -> None:
        while not self._shutting_down and self.subscriber_count > 0:
            if proc.poll() is not None:
                await asyncio.sleep(_NANOMSG_RETRY_S)
                continue
            sub = NanomsgSubscriber(url)
            try:
                await sub.connect()
                while True:
                    on_message(await sub.recv())
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("%s stream %s dropped: %s", self.name, url, exc)
                await asyncio.sleep(_NANOMSG_RETRY_S)
            finally:
                await sub.close()

    async def _consume_json(self, url: str, handler, proc: subprocess.Popen[bytes]) -> None:
        def on_message(raw: bytes) -> None:
            try:
                handler(json.loads(raw))
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass

        await self._consume_stream(url, proc, on_message)

    async def _consume_symbols(self, url: str, proc: subprocess.Popen[bytes]) -> None:
        def on_message(raw: bytes) -> None:
            # int8 I/Q pairs, full-scale ±127 → normalize to ±1.
            if len(raw) < 4:
                return
            iq = np.frombuffer(raw, dtype=np.int8)
            iq = iq[: (iq.size // 2) * 2].reshape(-1, 2).astype(np.float64) / 127.0
            step = max(1, len(iq) // (_CONSTELLATION_POINTS * 2))
            self._link.update_symbols([(float(i), float(q)) for i, q in iq[::step]])

        await self._consume_stream(url, proc, on_message)

    async def _consume_packets(self, url: str, proc: subprocess.Popen[bytes]) -> None:
        def on_message(raw: bytes) -> None:
            if len(raw) != VCDU_BYTES:
                return
            # VCDU primary header: 2-bit version, 8-bit SCID, 6-bit VCID.
            vcid = raw[1] & 0x3F
            self._link.update_vcdu(vcid)

        await self._consume_stream(url, proc, on_message)

    async def _pipe_output(self, proc: subprocess.Popen[bytes], label: str) -> None:
        stdout = proc.stdout
        if stdout is None:
            return
        while True:
            line = await asyncio.to_thread(stdout.readline)
            if not line:
                return
            logger.info("[%s] %s", label, line.decode("utf-8", errors="replace").rstrip())

    async def _kill_subprocesses(self) -> None:
        procs, self._procs = self._procs, []
        for proc in procs:
            if proc.poll() is not None:
                continue
            try:
                proc.terminate()
                await asyncio.to_thread(proc.wait, self.subprocess_kill_timeout_s)
            except subprocess.TimeoutExpired:
                logger.warning("%s pid=%d did not exit on SIGTERM; sending SIGKILL", self.name, proc.pid)
                proc.kill()
                try:
                    await asyncio.to_thread(proc.wait, self.subprocess_kill_timeout_s)
                except subprocess.TimeoutExpired:
                    logger.error("%s pid=%d refused to die after SIGKILL", self.name, proc.pid)
            except Exception:
                logger.exception("%s subprocess termination failed", self.name)

    # ── Status frames ────────────────────────────────────────────────

    def _publish_frame(self) -> None:
        cfg = self._cfg
        link = self._link
        demod_locked = link.snr_db is not None and link.snr_db >= cfg.snr_lock_db
        frame_lock = link.frame_lock
        if frame_lock:
            stage = "data" if link.vcdu_total > 0 else "frames"
        elif demod_locked:
            stage = "signal"
        else:
            stage = "searching"

        frame = GoesFrame(
            timestamp=time.time(),
            stage=stage,
            mode=self.mode,
            snr_db=link.snr_db,
            snr_lock_db=cfg.snr_lock_db,
            freq_offset_hz=link.freq_offset_hz,
            gain=link.gain,
            constellation=link.constellation,
            demod_locked=demod_locked,
            frame_lock=frame_lock,
            symbol_rate_baud=cfg.symbol_rate_baud,
            frames_total=link.frames_total,
            frames_bad=link.frames_bad,
            viterbi_errors_avg=link.viterbi_errors_avg(),
            rs_corrected=link.rs_corrected,
            skipped_symbols=link.skipped_symbols,
            vcdu_total=link.vcdu_total,
            vcdu_fill=link.vcdu_fill,
            vcdu_counts={str(k): v for k, v in sorted(link.vcdu_counts.items())},
            products_total=self.products.total,
            last_product_at=self.products.last_product_at,
            data_rate_kbps=link.data_rate_kbps(),
        )
        self._latest = frame
        self.publish(frame)


__all__ = ("GoesService", "GoesFrame", "estimate_snr_db")
