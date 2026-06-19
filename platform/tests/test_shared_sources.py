"""Drift guard for source files vendored byte-for-byte across both services.

The hardware and platform services deploy to different machines with separate
Docker build contexts, so neither can import from a shared third package. A
handful of tiny infra modules (currently just ``services/_pubsub.py``) are
therefore duplicated verbatim in each package. This test fails the moment the
copies diverge, turning silent drift into a red build.

It runs from the platform suite, which CI always exercises; it skips cleanly in
a deployed image where only one package is present on disk.
"""
from __future__ import annotations

from pathlib import Path

import pytest

# Each entry: the path of one vendored module relative to its package root,
# paired across both service packages. Add a row when a new file is vendored.
_MIRRORED_SOURCES = [
    (
        "hardware/src/rt_hardware/services/_pubsub.py",
        "platform/src/rt_platform/services/_pubsub.py",
    ),
]


def _repo_root() -> Path | None:
    """Walk up from this test file to the monorepo root (holds both packages)."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "hardware").is_dir() and (parent / "platform").is_dir():
            return parent
    return None


@pytest.mark.parametrize("hardware_rel, platform_rel", _MIRRORED_SOURCES)
def test_vendored_sources_are_byte_identical(hardware_rel: str, platform_rel: str) -> None:
    root = _repo_root()
    if root is None:
        pytest.skip("monorepo root not found (deployed single-package image)")

    a, b = root / hardware_rel, root / platform_rel
    if not a.exists() or not b.exists():
        pytest.skip("sibling package not present (deployed single-package image)")

    if a.read_bytes() != b.read_bytes():
        pytest.fail(
            f"Vendored mirror has drifted:\n  {hardware_rel}\n  {platform_rel}\n"
            "These files must stay byte-identical — edit one and copy it verbatim "
            "to the other. See the VENDORED MIRROR note at the top of each file."
        )
