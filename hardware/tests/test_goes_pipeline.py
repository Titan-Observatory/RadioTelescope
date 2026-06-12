"""Smoke tests for the GNU Radio GOES demod pipeline subprocess.

Gated on GNU Radio being importable, exactly like the spectrum pipeline
tests — they skip cleanly on CI / dev laptops and run on the Pi.
"""
from __future__ import annotations

import pytest

pytest.importorskip("gnuradio", reason="GNU Radio not installed in this environment")


def test_goes_pipeline_module_imports_without_gnu_radio_runtime():
    import rt_hardware.goes_pipeline as pipeline  # noqa: F401 — import is the test

    assert hasattr(pipeline, "build_flowgraph")
    assert hasattr(pipeline, "main")


def test_goes_pipeline_builds_flowgraph_with_default_config():
    from rt_hardware import goes_pipeline
    from rt_hardware.config import GoesConfig

    class _Cfg:
        goes = GoesConfig()
        general = type("G", (), {"log_level": "INFO"})()

    try:
        tb, probes = goes_pipeline.build_flowgraph(_Cfg())
    except RuntimeError as exc:
        if "gr-soapy" in str(exc):
            pytest.skip("gr-soapy not installed in this environment")
        raise

    assert tb.name() == "rt-goes-pipeline"
    assert probes.symbol_rate == 927_000
