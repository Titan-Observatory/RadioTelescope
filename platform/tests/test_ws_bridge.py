from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from rt_platform.api import _proxy
from rt_platform.main import create_app
from rt_platform.services._pubsub import Broadcaster
from rt_platform.services.ws_bridge import JsonWsBridge


@pytest.mark.asyncio
async def test_json_ws_bridge_disables_upstream_protocol_pings(monkeypatch):
    import websockets

    captured_kwargs: dict = {}

    class FakeWebSocket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise asyncio.CancelledError

    def fake_connect(url: str, **kwargs):
        captured_kwargs.update(kwargs)
        return FakeWebSocket()

    monkeypatch.setattr(websockets, "connect", fake_connect)
    bridge = JsonWsBridge("ws://hardware:8001", "/ws/spectrum", name="test-bridge")

    with pytest.raises(asyncio.CancelledError):
        await bridge._run()

    assert captured_kwargs["ping_interval"] is None
    assert captured_kwargs["ping_timeout"] is None


_DISCONNECT = object()  # sentinel: queued by disconnect() to raise on read


class _FakeBrowserWS:
    """Send-only browser socket: records outgoing frames; reads block until a
    stray inbound frame is fed (returned) or the tab disconnects (raises)."""

    def __init__(self) -> None:
        self.sent: list = []
        self._inbound: asyncio.Queue = asyncio.Queue()

    async def send_json(self, frame) -> None:
        self.sent.append(frame)

    async def receive_text(self) -> str:
        item = await self._inbound.get()
        if item is _DISCONNECT:
            raise WebSocketDisconnect(code=1000)
        return item

    def feed_text(self, text: str) -> None:
        """Simulate the browser sending an (unexpected) text frame."""
        self._inbound.put_nowait(text)

    def disconnect(self) -> None:
        self._inbound.put_nowait(_DISCONNECT)


@pytest.mark.asyncio
async def test_pump_relays_frames_in_order():
    bridge: Broadcaster = Broadcaster()
    ws = _FakeBrowserWS()
    pump = asyncio.create_task(_proxy.pump_bridge_to_websocket(ws, bridge, frame_name="test"))
    await asyncio.sleep(0)  # let it subscribe and start racing the read
    assert bridge.subscriber_count == 1

    bridge.publish({"n": 1})
    bridge.publish({"n": 2})
    for _ in range(20):
        await asyncio.sleep(0)
        if len(ws.sent) >= 2:
            break
    assert ws.sent == [{"n": 1}, {"n": 2}]

    ws.disconnect()
    await asyncio.wait_for(pump, timeout=1.0)
    assert bridge.subscriber_count == 0  # unsubscribed on exit


@pytest.mark.asyncio
async def test_pump_ignores_stray_inbound_frame_and_keeps_streaming():
    """A browser sending an (unexpected) text frame must not end the stream —
    _drain_until_disconnect loops on receive_text and only stops on disconnect."""
    bridge: Broadcaster = Broadcaster()
    ws = _FakeBrowserWS()
    pump = asyncio.create_task(_proxy.pump_bridge_to_websocket(ws, bridge, frame_name="test"))
    await asyncio.sleep(0)

    ws.feed_text("stray ping")  # the read returns this and loops, not disconnects
    for _ in range(20):
        await asyncio.sleep(0)
    assert not pump.done()  # stream survived the stray frame

    bridge.publish({"n": 1})  # and still relays subsequent frames
    for _ in range(20):
        await asyncio.sleep(0)
        if ws.sent:
            break
    assert ws.sent == [{"n": 1}]

    ws.disconnect()
    await asyncio.wait_for(pump, timeout=1.0)
    assert bridge.subscriber_count == 0


@pytest.mark.asyncio
async def test_pump_stops_promptly_on_disconnect_with_no_traffic():
    """The bug the shared helper fixes: a quiet stream must still notice a
    closed tab immediately, not block on q.get() until the next frame."""
    bridge: Broadcaster = Broadcaster()
    ws = _FakeBrowserWS()
    pump = asyncio.create_task(_proxy.pump_bridge_to_websocket(ws, bridge, frame_name="test"))
    await asyncio.sleep(0)
    assert bridge.subscriber_count == 1

    # No frames are ever published. Disconnect must end the pump anyway.
    ws.disconnect()
    await asyncio.wait_for(pump, timeout=1.0)
    assert ws.sent == []
    assert bridge.subscriber_count == 0


# ── End-to-end auth rejection on the real WS endpoints ──────────────────────
# The pump tests above exercise the fan-out helper in isolation; these drive the
# actual /ws/* endpoints to pin the close code an unauthenticated browser gets
# (the queue gate must fire before any bridge work). Queue is enabled in the
# conftest config, so connecting without joining must be rejected with 1008.

@pytest.mark.parametrize("path", ["/ws/goes", "/ws/spectrum"])
def test_ws_endpoint_rejects_unauthorized_with_1008(platform_config_path: Path, path: str):
    with TestClient(create_app(platform_config_path)) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(path) as ws:
                ws.receive_text()
        assert exc.value.code == 1008
