# GOES observation mode

The telescope supports two observation modes, selected at boot on the
hardware service:

| | Hydrogen line (default) | GOES |
|---|---|---|
| LNA | Sawbird+ H1 | Sawbird+ GOES |
| Carrier | 1420.4 MHz | 1694.1 MHz |
| Config | `[sdr]` | `[goes]` |
| Pipeline | `rt_hardware.sdr_pipeline` (FFT/integrate) | `rt_hardware.goes_pipeline` (BPSK demod + Viterbi) |
| Service | `SpectrumService` → `/ws/spectrum` | `GoesService` → `/ws/goes` |
| Frontend | `SpectrumPanel`, baseline wizard, guided observation | `GoesConnectPanel`, `GoesDataExplorer` |

## Switching modes

1. Swap the LNA on the feed (both are powered the same way — separate 5 V
   injector or the Airspy bias tee via `lna_bias_tee_enabled`).
2. In `hardware/config.toml` set:

   ```toml
   [observation]
   mode = "goes"   # or "hydrogen_line"
   ```

3. Restart `rt-hardware`. The platform needs no config change and no restart
   — it proxies both surfaces unconditionally and the frontend picks its
   panel set from `GET /api/observation`.

The modes are deliberately segregated: each has its own config section,
pipeline subprocess, service, routes, WS bridge, and frontend components.
Only the selected mode's service is instantiated (the single Airspy can't be
shared), and nothing from one chain imports the other beyond the shared
Soapy source builder and the `Broadcaster` pubsub.

## GOES receive chain

```
Airspy @ 1694.1 MHz
  └─ goes_pipeline (GNU Radio subprocess)
       AGC → RRC matched filter → M&M clock recovery → Costas(2)
         ├─ metrics: SNR est, carrier offset, constellation, band PSD ──ZMQ──┐
         └─ complex→soft bits → Viterbi r=1/2 k=7 (CCSDS polys) → pack ─ZMQ─┐│
  └─ GoesService (asyncio)                                                  ││
       ├─ status frames  ◄──────────────────────────────────────────────────┘│
       └─ decode chain   ◄───────────────────────────────────────────────────┘
            Deframer (ASM 1ACFFC1D, polarity-ambiguity aware, flywheel)
            → CCSDS derandomizer → RS(255,223) dual-basis, interleave 4
            → VCDU demux → M_PDU → CCSDS space packets (CRC-16 checked)
            → LRIT session files (transport + header records)
            → ProductStore (images → PNG/JPEG/GIF, text bulletins, DCS)
```

Everything below the ZMQ boundary is pure Python and covered by unit tests
(`hardware/tests/test_goes_decode.py`) — the tests fabricate valid CADU
bitstreams with `rt_hardware.goes.encode` and run them through the real
chain.

## Simulate mode

```toml
[observation]
mode = "goes"

[goes]
simulate = true
```

No SDR required. The simulator generates demod metrics and a *real* CADU
bitstream (synthetic full-disk imagery + admin bulletins), so the production
decode chain, product store, and the entire frontend run unchanged. Signal
acquisition follows the dish: SNR rises as the mount closes on the target
satellite's look angles (from motor telemetry), so the slew → peak → lock
workflow is faithfully demoable end to end.

## Surfaces

Hardware (trusted network): `GET /api/observation`, `GET /api/goes/status`,
`POST /api/goes/reconnect`, `GET /api/goes/products[/{id}[/file]]`,
`DELETE /api/goes/products`, `WS /ws/goes`.

Platform (public, queue-gated): same paths proxied; reads need an active
queue session, mutations need control. `/api/observation` degrades to
`{"mode": "hydrogen_line", "degraded": true}` when the gateway is down.

## UI flow

1. **Connect panel** (right column, replaces the hydrogen-line spectrum
   panel): pick a satellite from the catalog, *Slew to satellite*, then peak
   the SNR meter — the acquisition stepper walks Searching → Signal → Frame
   lock → Data. A band PSD and live constellation show what the demodulator
   sees.
2. **Data explorer** (full-width below the sky map, appears at frame lock):
   link statistics (data rate, frame/CRC error rates, RS corrections),
   per-virtual-channel activity, and a gallery of decoded products with a
   lightbox viewer and download links.
