"""GOES downlink service.

Owns the GNU Radio demod subprocess ([rt_hardware.goes_pipeline]) the same
way SpectrumService owns the spectrum pipeline: lazy spawn on the first
WebSocket subscriber, idle close after the last one leaves, crash backoff
with reset. Two ZMQ streams come back from the subprocess:

* demod metrics (JSON) — merged with decoder statistics into status frames
  broadcast to ``/ws/goes`` subscribers;
* the Viterbi-decoded bitstream — run through the pure-Python decode chain
  (Deframer → derandomize → Reed-Solomon → VCDU demux → LRIT files) with
  decoded products persisted to the ProductStore.

``goes.simulate = true`` swaps the subprocess for [GoesSimulator], which
emits the same two streams synthetically — the decode chain, status frames,
product store and the entire frontend run unchanged.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

from rt_hardware.config import GoesConfig
from rt_hardware.goes.ccsds import Deframer, derandomize, interleave_decode
from rt_hardware.goes.lrit import VirtualChannelDemux
from rt_hardware.goes.products import ProductStore
from rt_hardware.goes.simulator import GoesSimulator
from rt_hardware.hardware.sdr import LnaController
from rt_hardware.models.state import LnaStatus
from rt_hardware.services._pubsub import Broadcaster

_STATE_DIR = Path(os.environ.get("RT_STATE_DIR", "."))

logger = logging.getLogger(__name__)


class GoesFrame(dict):
    """Plain dict so FastAPI's WebSocket can JSON-encode it cheaply."""


class _PipelineDied(RuntimeError):
    """The GOES demod subprocess exited or stopped sending data."""


class _DecodeState:
    """Per-run decode chain + counters (reset on every pipeline (re)spawn)."""

    def __init__(self, rs_enabled: bool) -> None:
        self.rs_enabled = rs_enabled
        self.deframer = Deframer()
        self.demux = VirtualChannelDemux()
        self.frames_bad = 0
        self.rs_corrected = 0
        self.products_added = 0
        # (timestamp, payload_bytes) over a sliding window for the data rate.
        self.recent_bytes: deque[tuple[float, int]] = deque()

    def data_rate_kbps(self) -> float:
        now = time.monotonic()
        while self.recent_bytes and now - self.recent_bytes[0][0] > 10.0:
            self.recent_bytes.popleft()
        if not self.recent_bytes:
            return 0.0
        span = max(1.0, now - self.recent_bytes[0][0])
        total = sum(n for _, n in self.recent_bytes)
        return total * 8.0 / span / 1000.0


class GoesService(Broadcaster[GoesFrame]):
    name: str = "goes-service"
    idle_close_delay_s: float = 30.0
    subprocess_start_timeout_s: float = 15.0
    subprocess_kill_timeout_s: float = 2.0
    _backoff_schedule: tuple[float, ...] = (1.0, 2.0, 5.0, 15.0, 30.0)

    def __init__(
        self,
        cfg: GoesConfig,
        config_path: str | Path,
        *,
        beam_fwhm_deg: float = 1.2,
        pointing_error_deg: Callable[[], float | None] | None = None,
    ) -> None:
        super().__init__()
        self._cfg = cfg
        self._config_path = str(config_path)
        self._beam_fwhm_deg = beam_fwhm_deg
        self._pointing_error_deg = pointing_error_deg
        # The Sawbird+ GOES rides the same Airspy bias tee as the H1 LNA;
        # LnaController only reads `lna_bias_tee_enabled`, which GoesConfig
        # also carries.
        self._lna = LnaController(cfg)  # type: ignore[arg-type]
        self.products = ProductStore(_STATE_DIR / cfg.products_dir, cfg.max_products)

        self._latest: GoesFrame | None = None
        self._decode = _DecodeState(cfg.rs_enabled)
        self._proc: subprocess.Popen[bytes] | None = None
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

    @property
    def pipeline_pid(self) -> int | None:
        proc = self._proc
        return proc.pid if proc is not None and proc.poll() is None else None

    @property
    def lna_status(self) -> LnaStatus:
        return self._lna.status

    async def apply_configured_bias_tee(self) -> LnaStatus:
        """Apply the configured bias-tee state at boot (see SpectrumService)."""
        if not self._cfg.lna_bias_tee_enabled:
            return self._lna.status
        return await self._lna.set(self._cfg.lna_bias_tee_enabled)

    def status_snapshot(self) -> dict[str, Any]:
        latest = self._latest
        return {
            "enabled": True,
            "mode": self.mode,
            "stage": latest.get("stage") if latest else "idle",
            "simulate": self._cfg.simulate,
            "downlink_freq_mhz": self._cfg.downlink_freq_hz / 1e6,
            "sample_rate_mhz": self._cfg.sample_rate_hz / 1e6,
            "symbol_rate_baud": self._cfg.symbol_rate_baud,
            "rs_enabled": self._cfg.rs_enabled,
            "lna": self._lna.status.model_dump(),
            "latest_timestamp": latest.get("timestamp") if latest else None,
            "subscriber_count": self.subscriber_count,
            "pipeline_pid": self.pipeline_pid,
            "fault_detail": self._fault_detail,
            "products_total": self.products.total,
        }

    # ── Lifecycle ────────────────────────────────────────────────────

    async def start(self) -> None:
        logger.info(
            "%s ready (lazy — %s spawns on first subscriber)",
            self.name, "simulator" if self._cfg.simulate else "pipeline",
        )

    async def stop(self) -> None:
        self._shutting_down = True
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            await self._stop_supervisor_locked()
        logger.info("%s stopped", self.name)

    async def reconnect(self) -> str:
        """Kill and respawn the demod pipeline (or simulator)."""
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
        self._decode = _DecodeState(self._cfg.rs_enabled)
        runner = self._run_simulator if self._cfg.simulate else self._run_pipeline
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
        await self._kill_subprocess()
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
            started = time.monotonic()
            try:
                await runner()
                return  # clean exit
            except asyncio.CancelledError:
                raise
            except _PipelineDied as exc:
                self._mode = "fault"
                self._fault_detail = str(exc)
                logger.warning("%s pipeline died: %s", self.name, exc)
            except Exception as exc:
                self._mode = "fault"
                self._fault_detail = f"GOES consumer crashed: {exc}"
                logger.exception("%s crashed", self.name)
            finally:
                await self._kill_subprocess()

            if time.monotonic() - started > 60.0:
                backoff_index = 0  # it ran for a while; treat the crash as fresh
            if self._shutting_down or self.subscriber_count == 0:
                return
            wait = self._backoff_schedule[min(backoff_index, len(self._backoff_schedule) - 1)]
            backoff_index += 1
            logger.info("%s respawning in %.1fs (attempt %d)", self.name, wait, backoff_index)
            await asyncio.sleep(wait)
            self._decode = _DecodeState(self._cfg.rs_enabled)

    # ── Simulator backend ─────────────────────────────────────────────

    async def _run_simulator(self) -> None:
        sim = GoesSimulator(self._cfg, self._pointing_error_deg, self._beam_fwhm_deg)
        self._mode = "running"
        period = 1.0 / self._cfg.status_rate_hz
        while not self._shutting_down and self.subscriber_count > 0:
            metrics = sim.metrics()
            chunk = sim.data_chunk()
            if chunk:
                await asyncio.to_thread(self._decode_chunk, chunk)
            self._publish_frame(metrics)
            await asyncio.sleep(period)

    # ── Real pipeline backend ─────────────────────────────────────────

    async def _run_pipeline(self) -> None:
        cmd = [sys.executable, "-m", "rt_hardware.goes_pipeline", "--config", self._config_path]
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            self._mode = "unavailable"
            self._fault_detail = f"Could not exec {cmd[0]}: {exc}"
            raise _PipelineDied(self._fault_detail) from exc
        self._proc = proc
        self._mode = "starting"
        logger.info("%s spawned pipeline subprocess pid=%d", self.name, proc.pid)

        stderr_task = asyncio.create_task(self._pipe_stderr(proc), name=f"{self.name}-stderr")
        metrics_task = asyncio.create_task(self._consume_metrics(proc), name=f"{self.name}-metrics")
        data_task = asyncio.create_task(self._consume_data(proc), name=f"{self.name}-data")
        tasks = (stderr_task, metrics_task, data_task)
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

    async def _consume_metrics(self, proc: subprocess.Popen[bytes]) -> None:
        sock = self._open_sub_socket(self._cfg.metrics_ipc_path)
        recv_timeout_s = 5.0 / self._cfg.status_rate_hz
        first_deadline = time.monotonic() + self.subprocess_start_timeout_s
        saw_frame = False
        try:
            while not self._shutting_down and self.subscriber_count > 0:
                if proc.poll() is not None:
                    raise _PipelineDied(f"subprocess exited with code {proc.returncode}")
                try:
                    raw = await asyncio.wait_for(sock.recv(), timeout=recv_timeout_s)
                except asyncio.TimeoutError:
                    if not saw_frame and time.monotonic() > first_deadline:
                        raise _PipelineDied("no demod metrics within startup grace period")
                    continue
                try:
                    metrics = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                saw_frame = True
                if self._mode != "running":
                    self._mode = "running"
                    self._fault_detail = None
                self._publish_frame(metrics)
        finally:
            sock.close(0)

    async def _consume_data(self, proc: subprocess.Popen[bytes]) -> None:
        sock = self._open_sub_socket(self._cfg.data_ipc_path)
        try:
            while not self._shutting_down and self.subscriber_count > 0:
                try:
                    chunk = await asyncio.wait_for(sock.recv(), timeout=2.0)
                except asyncio.TimeoutError:
                    # Quiet bitstream is normal while hunting for the carrier;
                    # the metrics consumer owns liveness checks.
                    continue
                if chunk:
                    await asyncio.to_thread(self._decode_chunk, bytes(chunk))
        finally:
            sock.close(0)

    def _open_sub_socket(self, ipc_path: str):
        try:
            import zmq  # type: ignore[import-not-found]
            import zmq.asyncio  # type: ignore[import-not-found]
        except ImportError as exc:
            self._mode = "unavailable"
            self._fault_detail = "pyzmq is not installed"
            raise _PipelineDied(str(exc)) from exc
        ctx = zmq.asyncio.Context.instance()
        sock = ctx.socket(zmq.SUB)
        sock.setsockopt(zmq.SUBSCRIBE, b"")
        sock.setsockopt(zmq.RCVHWM, 16)
        sock.setsockopt(zmq.LINGER, 0)
        sock.connect(ipc_path)
        return sock

    async def _pipe_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        stderr = proc.stderr
        if stderr is None:
            return
        while True:
            line = await asyncio.to_thread(stderr.readline)
            if not line:
                return
            logger.info("[goes-pipeline] %s", line.decode("utf-8", errors="replace").rstrip())

    async def _kill_subprocess(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
            await asyncio.to_thread(proc.wait, self.subprocess_kill_timeout_s)
        except subprocess.TimeoutExpired:
            logger.warning("%s subprocess did not exit on SIGTERM; sending SIGKILL", self.name)
            proc.kill()
            try:
                await asyncio.to_thread(proc.wait, self.subprocess_kill_timeout_s)
            except subprocess.TimeoutExpired:
                logger.error("%s subprocess refused to die after SIGKILL", self.name)
        except Exception:
            logger.exception("%s subprocess termination failed", self.name)

    # ── Decode chain (runs in a worker thread) ────────────────────────

    def _decode_chunk(self, chunk: bytes) -> None:
        decode = self._decode
        for codeblock in decode.deframer.feed(chunk):
            result = interleave_decode(derandomize(codeblock), rs_enabled=decode.rs_enabled)
            if result is None:
                decode.frames_bad += 1
                continue
            vcdu, corrected = result
            decode.rs_corrected += corrected
            decode.recent_bytes.append((time.monotonic(), len(vcdu)))
            try:
                files = decode.demux.feed(vcdu)
            except Exception:
                logger.exception("VCDU demux failed")
                continue
            for lrit_file in files:
                product = self.products.add_lrit(lrit_file)
                if product is not None:
                    decode.products_added += 1
                    logger.info(
                        "Decoded product %s (%s, %d bytes)",
                        product.name, product.kind, product.size_bytes,
                    )

    # ── Status frames ────────────────────────────────────────────────

    def _publish_frame(self, metrics: dict) -> None:
        cfg = self._cfg
        decode = self._decode
        snr_db = metrics.get("snr_db")
        demod_locked = snr_db is not None and snr_db >= cfg.snr_lock_db
        frame_lock = decode.deframer.locked
        if frame_lock:
            stage = "data" if decode.demux.packets_total > 0 else "frames"
        elif demod_locked:
            stage = "signal"
        else:
            stage = "searching"

        frame = GoesFrame(
            timestamp=metrics.get("timestamp", time.time()),
            stage=stage,
            mode=self.mode,
            snr_db=snr_db,
            snr_lock_db=cfg.snr_lock_db,
            freq_offset_hz=metrics.get("freq_offset_hz"),
            constellation=metrics.get("constellation", []),
            psd_db=metrics.get("psd_db", []),
            psd_center_mhz=cfg.downlink_freq_hz / 1e6,
            psd_span_mhz=cfg.sample_rate_hz / 1e6,
            demod_locked=demod_locked,
            frame_lock=frame_lock,
            symbol_rate_baud=cfg.symbol_rate_baud,
            frames_total=decode.deframer.stats.frames_total,
            frames_bad=decode.frames_bad,
            frames_flywheel=decode.deframer.stats.frames_flywheel,
            sync_losses=decode.deframer.stats.sync_losses,
            rs_corrected=decode.rs_corrected,
            vcdu_total=decode.demux.vcdu_total,
            vcdu_fill=decode.demux.vcdu_fill,
            vcdu_counts={str(k): v for k, v in sorted(decode.demux.vcdu_counts.items())},
            packets_total=decode.demux.packets_total,
            packets_crc_err=decode.demux.packets_crc_err,
            files_completed=decode.demux.files_completed,
            files_aborted=decode.demux.files_aborted,
            products_total=self.products.total,
            last_product_at=self.products.last_product_at,
            data_rate_kbps=round(decode.data_rate_kbps(), 1),
        )
        self._latest = frame
        self.publish(frame)


__all__ = ("GoesService", "GoesFrame")
