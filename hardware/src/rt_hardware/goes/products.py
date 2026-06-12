"""Disk-backed store for decoded GOES products.

Products are written to ``<RT_STATE_DIR>/<products_dir>`` with a JSON index
so they survive restarts. The store is bounded: the oldest products are
pruned past ``max_products``. Access is guarded by a lock because decode
runs in a worker thread while the HTTP routes read from the event loop.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

import numpy as np

from rt_hardware.goes.lrit import LritFile
from rt_hardware.models.state import GoesProduct

logger = logging.getLogger(__name__)

_MEDIA_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "text/plain": ".txt",
    "application/octet-stream": ".bin",
}
_TEXT_PREVIEW_CHARS = 400


class ProductStore:
    def __init__(self, directory: Path, max_products: int = 200) -> None:
        self._dir = directory
        self._max = max_products
        self._lock = threading.Lock()
        self._products: list[GoesProduct] = []  # newest first
        self._counter = 0
        self._dir.mkdir(parents=True, exist_ok=True)
        self._load_index()

    # ── Public API ────────────────────────────────────────────────────

    @property
    def total(self) -> int:
        with self._lock:
            return len(self._products)

    @property
    def last_product_at(self) -> float | None:
        with self._lock:
            return self._products[0].created_at if self._products else None

    def list(self, limit: int = 50) -> list[GoesProduct]:
        with self._lock:
            return list(self._products[: max(0, limit)])

    def get(self, product_id: str) -> tuple[GoesProduct, Path] | None:
        with self._lock:
            for product in self._products:
                if product.id == product_id:
                    path = self._path_for(product)
                    return (product, path) if path.exists() else None
        return None

    def clear(self) -> int:
        with self._lock:
            removed = len(self._products)
            for product in self._products:
                self._path_for(product).unlink(missing_ok=True)
            self._products = []
            self._write_index_locked()
        return removed

    def add_lrit(self, lrit: LritFile) -> GoesProduct | None:
        """Persist a decoded LRIT file, rendering raw images to PNG."""
        kind = lrit.kind
        data = lrit.data
        media_type = "application/octet-stream"
        preview: str | None = None

        if kind == "image":
            media_type, data = self._prepare_image(lrit)
            if media_type == "application/octet-stream":
                kind = "binary"
        elif kind in ("text", "dcs"):
            media_type = "text/plain" if kind == "text" else "application/octet-stream"
            if kind == "text":
                preview = data.decode("utf-8", errors="replace")[:_TEXT_PREVIEW_CHARS].strip() or None

        if not data:
            return None

        with self._lock:
            self._counter += 1
            product = GoesProduct(
                id=f"{int(time.time() * 1000):x}-{self._counter}",
                kind=kind,  # type: ignore[arg-type]
                name=lrit.annotation or f"vc{lrit.vcid}-apid{lrit.apid}-{self._counter}",
                file_type=lrit.file_type,
                vcid=lrit.vcid,
                apid=lrit.apid,
                size_bytes=len(data),
                created_at=time.time(),
                media_type=media_type,
                preview=preview,
                columns=lrit.columns,
                lines=lrit.lines,
                segment=lrit.segment,
                segment_total=lrit.segment_total,
            )
            try:
                self._path_for(product).write_bytes(data)
            except Exception:
                logger.exception("Failed to write product %s", product.id)
                return None
            self._products.insert(0, product)
            self._prune_locked()
            self._write_index_locked()
        return product

    # ── Internals ─────────────────────────────────────────────────────

    def _prepare_image(self, lrit: LritFile) -> tuple[str, bytes]:
        data = lrit.data
        if data.startswith(b"\xff\xd8"):
            return "image/jpeg", data
        if data.startswith(b"GIF8"):
            return "image/gif", data
        if data.startswith(b"\x89PNG"):
            return "image/png", data
        # Uncompressed 8-bit imagery: render to PNG so the browser can show it.
        if (
            (lrit.compression in (None, 0))
            and lrit.bits_per_pixel == 8
            and lrit.columns
            and lrit.lines
            and len(data) >= lrit.columns * lrit.lines
        ):
            try:
                import cv2

                pixels = np.frombuffer(
                    data[: lrit.columns * lrit.lines], dtype=np.uint8,
                ).reshape(lrit.lines, lrit.columns)
                ok, png = cv2.imencode(".png", pixels)
                if ok:
                    return "image/png", png.tobytes()
            except Exception:
                logger.exception("Failed to render raw LRIT image")
        return "application/octet-stream", data

    def _path_for(self, product: GoesProduct) -> Path:
        ext = _MEDIA_EXT.get(product.media_type, ".bin")
        return self._dir / f"{product.id}{ext}"

    def _prune_locked(self) -> None:
        while len(self._products) > self._max:
            old = self._products.pop()
            self._path_for(old).unlink(missing_ok=True)

    def _index_path(self) -> Path:
        return self._dir / "index.json"

    def _write_index_locked(self) -> None:
        try:
            payload = json.dumps(
                {"counter": self._counter, "products": [p.model_dump() for p in self._products]},
            )
            self._index_path().write_text(payload)
        except Exception:
            logger.exception("Failed to persist product index")

    def _load_index(self) -> None:
        path = self._index_path()
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text())
            self._counter = int(raw.get("counter", 0))
            products = [GoesProduct.model_validate(p) for p in raw.get("products", [])]
            self._products = [p for p in products if self._path_for(p).exists()]
        except Exception:
            logger.exception("Failed to load product index %s; starting empty", path)
            self._products = []


__all__ = ("ProductStore",)
