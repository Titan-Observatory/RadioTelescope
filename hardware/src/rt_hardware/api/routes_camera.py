from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

logger = logging.getLogger("radiotelescope.camera")
router = APIRouter(tags=["camera"])

try:
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False
    logger.warning("opencv-python not installed — camera stream disabled")


async def _frames(device: int, fps: int, width: int, height: int, request: Request) -> AsyncIterator[bytes]:
    loop = asyncio.get_event_loop()
    cap = await loop.run_in_executor(None, cv2.VideoCapture, device)

    if not await loop.run_in_executor(None, cap.isOpened):
        await loop.run_in_executor(None, cap.release)
        return

    await loop.run_in_executor(None, cap.set, cv2.CAP_PROP_FRAME_WIDTH, width)
    await loop.run_in_executor(None, cap.set, cv2.CAP_PROP_FRAME_HEIGHT, height)

    delay = 1.0 / max(fps, 1)
    try:
        while True:
            if await request.is_disconnected():
                break
            ret, frame = await loop.run_in_executor(None, cap.read)
            if not ret:
                break
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if not ok:
                continue
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            await asyncio.sleep(delay)
    finally:
        await loop.run_in_executor(None, cap.release)


async def _camera_available(device: int) -> bool:
    loop = asyncio.get_event_loop()
    cap = await loop.run_in_executor(None, cv2.VideoCapture, device)
    try:
        return await loop.run_in_executor(None, cap.isOpened)
    finally:
        await loop.run_in_executor(None, cap.release)


@router.get("/api/camera/stream")
async def camera_stream(request: Request) -> StreamingResponse:
    cfg = getattr(request.app.state.config, "camera", None)
    if cfg is None or not cfg.enabled:
        raise HTTPException(404, "Camera not configured or disabled")
    if not _CV2:
        raise HTTPException(503, "opencv-python not installed on this host")

    return StreamingResponse(
        _frames(cfg.device, cfg.fps, cfg.width, cfg.height, request),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@router.get("/api/camera/status")
async def camera_status(request: Request) -> Response:
    cfg = getattr(request.app.state.config, "camera", None)
    enabled = cfg is not None and cfg.enabled and _CV2
    if enabled:
        enabled = await _camera_available(cfg.device)
    import json
    return Response(
        content=json.dumps({"enabled": enabled, "label": cfg.label if cfg else "Cam A"}),
        media_type="application/json",
    )
