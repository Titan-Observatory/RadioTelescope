"""GNU Radio flowgraph that demodulates the GOES HRIT/LRIT downlink.

Runs as a standalone subprocess spawned by
[rt_hardware.services.goes.GoesService], mirroring the spectrum pipeline's
architecture: the heavy per-sample DSP stays in GNU Radio's C++ scheduler,
and the Python service consumes the results over ZeroMQ. Two PUB sockets:

* ``data_ipc_path`` — the Viterbi-decoded, packed bitstream. Frame sync,
  derandomization, Reed-Solomon and LRIT parsing all happen on the Python
  side ([rt_hardware.goes.ccsds] / [rt_hardware.goes.lrit]) where they are
  unit-testable.
* ``metrics_ipc_path`` — JSON demod telemetry at ``status_rate_hz``: SNR
  estimate, carrier frequency offset, a constellation sample, and a coarse
  PSD of the downlink band for the pointing-assist display.

Demod chain (BPSK, rate-1/2 convolutional code, CCSDS polys with the G2
branch inverted — gr-fec expresses the inversion as a negative poly)::

    soapy.source(airspy @ downlink_freq)
        ▼
    analog.agc_cc
        ▼
    fir_filter_ccf(RRC matched filter)
        ▼
    digital.clock_recovery_mm_cc(sps)        # symbol timing → 1 sps
        ▼
    digital.costas_loop_cc(order=2)          # carrier phase/freq
        ├──▶ probe_mpsk_snr_est_c            # → metrics
        ├──▶ keep_one_in_n → probe (vector)  # → constellation sample
        ▼
    complex_to_real                          # soft symbols
        ▼
    fec.extended_decoder(cc_decoder)         # Viterbi r=1/2 k=7
        ▼
    [digital.diff_decoder_bb]                # NRZ-M, LRIT only
        ▼
    blocks.pack_k_bits_bb(8) → zeromq.pub_sink

The 180° BPSK phase ambiguity is resolved downstream by the Python deframer
(it matches both the ASM and its complement), so no phase-flip logic is
needed here.

Importable only where GNU Radio is installed; the service reports
``mode="unavailable"`` otherwise — same contract as [rt_hardware.sdr_pipeline].
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import signal
import sys
import threading
import time

import numpy as np

from rt_hardware.config import load_config
from rt_hardware.sdr_pipeline import build_airspy_source

logger = logging.getLogger(__name__)

PSD_FFT_SIZE = 1024
PSD_OUTPUT_BINS = 256
CONSTELLATION_POINTS = 128
POWER_FLOOR = 1e-12


class PipelineProbes:
    """Handles onto the running flowgraph the metrics thread reads from."""

    def __init__(self, snr_probe, costas, constellation_probe, psd_probe, symbol_rate: float) -> None:
        self.snr_probe = snr_probe
        self.costas = costas
        self.constellation_probe = constellation_probe
        self.psd_probe = psd_probe
        self.symbol_rate = symbol_rate

    def snapshot(self) -> dict:
        snr_db: float | None = None
        try:
            snr_db = float(self.snr_probe.snr())
            if not math.isfinite(snr_db):
                snr_db = None
        except Exception:
            pass

        freq_offset_hz: float | None = None
        try:
            # costas frequency is radians/sample at the symbol rate.
            freq_offset_hz = float(self.costas.frequency()) * self.symbol_rate / (2.0 * math.pi)
        except Exception:
            pass

        constellation: list[list[float]] = []
        try:
            for value in self.constellation_probe.level():
                constellation.append([round(value.real, 4), round(value.imag, 4)])
        except Exception:
            pass

        psd_db: list[float] = []
        try:
            power = np.asarray(self.psd_probe.level(), dtype=np.float64)
            if power.size == PSD_FFT_SIZE:
                folded = power.reshape(PSD_OUTPUT_BINS, -1).mean(axis=1)
                psd_db = np.round(
                    10.0 * np.log10(np.maximum(folded, POWER_FLOOR)), 2,
                ).tolist()
        except Exception:
            pass

        return {
            "timestamp": time.time(),
            "snr_db": None if snr_db is None else round(snr_db, 2),
            "freq_offset_hz": None if freq_offset_hz is None else round(freq_offset_hz, 1),
            "constellation": constellation,
            "psd_db": psd_db,
        }


def build_flowgraph(cfg):
    """Construct the live demod ``gr.top_block``; returns (top_block, probes).

    GNU Radio imports are deferred so the module can be imported on hosts
    without the system dependency (tests, help text).
    """
    from gnuradio import analog, blocks, digital, fec, fft, gr, zeromq  # type: ignore[import-not-found]
    from gnuradio import filter as gr_filter  # type: ignore[import-not-found]
    from gnuradio.fft import window  # type: ignore[import-not-found]
    from gnuradio.filter import firdes  # type: ignore[import-not-found]

    try:
        from gnuradio import soapy  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "gr-soapy is not installed. On Debian/Ubuntu: `apt install gr-soapy`."
        ) from exc

    single_pole_iir = getattr(gr_filter, "single_pole_iir_filter_ff", None) \
        or getattr(blocks, "single_pole_iir_filter_ff")

    goes = cfg.goes
    sample_rate = float(goes.sample_rate_hz)
    symbol_rate = float(goes.symbol_rate_baud)
    sps = sample_rate / symbol_rate

    tb = gr.top_block("rt-goes-pipeline")

    source = build_airspy_source(soapy, sample_rate, goes.downlink_freq_hz, goes.gain_db)

    # ── Demod chain ───────────────────────────────────────────────────
    agc = analog.agc_cc(1e-3, 1.0, 1.0)
    ntaps = int(11 * sps) | 1
    rrc_taps = firdes.root_raised_cosine(1.0, sample_rate, symbol_rate, float(goes.rrc_rolloff), ntaps)
    matched = gr_filter.fir_filter_ccf(1, rrc_taps)
    # Mueller & Müller timing recovery — tolerant of the fractional
    # samples-per-symbol (3 Msps / 927 kbaud ≈ 3.236).
    gain_mu = 0.175
    clock = digital.clock_recovery_mm_cc(sps, 0.25 * gain_mu * gain_mu, 0.5, gain_mu, 0.005)
    costas = digital.costas_loop_cc(0.015, 2, False)

    snr_probe = digital.probe_mpsk_snr_est_c(digital.SNR_EST_M2M4, 10_000, 0.001)

    to_soft = blocks.complex_to_real()
    # CCSDS rate-1/2 k=7 convolutional code; the negative poly inverts the
    # G2 branch per the NASA convention.
    cc = fec.cc_decoder.make(2048, 7, 2, [79, -109], 0, -1, fec.CC_STREAMING, False)
    viterbi = fec.extended_decoder(
        decoder_obj_list=cc, threading=None, ann=None, puncpat="11", integration_period=10_000,
    )

    bit_chain: list = [viterbi]
    if goes.diff_decode:
        bit_chain.append(digital.diff_decoder_bb(2))
    pack = blocks.pack_k_bits_bb(8)
    data_sink = zeromq.pub_sink(gr.sizeof_char, 1, goes.data_ipc_path, 100, False, 64, "")

    tb.connect(source, agc, matched, clock, costas, to_soft, *bit_chain, pack, data_sink)
    tb.connect(costas, snr_probe)

    # ── Constellation sample (post-costas symbols) ────────────────────
    # Decimate to a slow trickle so the probe holds a fresh, sparse picture.
    const_decim = max(1, int(symbol_rate / (CONSTELLATION_POINTS * 4)))
    const_keep = blocks.keep_one_in_n(gr.sizeof_gr_complex, const_decim)
    const_vec = blocks.stream_to_vector(gr.sizeof_gr_complex, CONSTELLATION_POINTS)
    const_probe = blocks.probe_signal_vc(CONSTELLATION_POINTS)
    tb.connect(costas, const_keep, const_vec, const_probe)

    # ── Coarse PSD of the downlink band (pointing assist) ─────────────
    psd_s2v = blocks.stream_to_vector(gr.sizeof_gr_complex, PSD_FFT_SIZE)
    psd_fft = fft.fft_vcc(PSD_FFT_SIZE, True, window.hann(PSD_FFT_SIZE), True, 1)
    psd_mag2 = blocks.complex_to_mag_squared(PSD_FFT_SIZE)
    psd_ema = single_pole_iir(0.05, PSD_FFT_SIZE)
    psd_probe = blocks.probe_signal_vf(PSD_FFT_SIZE)
    tb.connect(source, psd_s2v, psd_fft, psd_mag2, psd_ema, psd_probe)

    probes = PipelineProbes(snr_probe, costas, const_probe, psd_probe, symbol_rate)

    logger.info(
        "GOES flowgraph built: %.4f MHz, %.1f Msps, %.0f baud (sps=%.3f), rrc=%.2f, "
        "diff_decode=%s, data=%s, metrics=%s",
        goes.downlink_freq_hz / 1e6, sample_rate / 1e6, symbol_rate, sps,
        goes.rrc_rolloff, goes.diff_decode, goes.data_ipc_path, goes.metrics_ipc_path,
    )
    return tb, probes


def _publish_metrics(probes: PipelineProbes, ipc_path: str, rate_hz: float, stop: threading.Event) -> None:
    import zmq  # type: ignore[import-not-found]

    ctx = zmq.Context.instance()
    sock = ctx.socket(zmq.PUB)
    sock.setsockopt(zmq.SNDHWM, 4)
    sock.setsockopt(zmq.LINGER, 0)
    sock.bind(ipc_path)
    period = 1.0 / max(rate_hz, 1e-3)
    try:
        while not stop.wait(period):
            try:
                sock.send_string(json.dumps(probes.snapshot()))
            except Exception:
                logger.exception("Metrics publish failed")
    finally:
        sock.close(0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GNU Radio GOES demod pipeline (subprocess of rt-hardware).")
    parser.add_argument("-c", "--config", required=True, help="Path to hardware config.toml")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level, logging.INFO),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        stream=sys.stderr,
    )

    tb, probes = build_flowgraph(cfg)

    stop = threading.Event()
    metrics_thread = threading.Thread(
        target=_publish_metrics,
        args=(probes, cfg.goes.metrics_ipc_path, cfg.goes.status_rate_hz, stop),
        name="goes-metrics",
        daemon=True,
    )

    def _shutdown(signum, _frame):
        logger.info("Received signal %d; stopping flowgraph", signum)
        stop.set()
        tb.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    tb.start()
    metrics_thread.start()
    tb.wait()
    stop.set()
    metrics_thread.join(timeout=2)
    logger.info("GOES flowgraph exited cleanly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
