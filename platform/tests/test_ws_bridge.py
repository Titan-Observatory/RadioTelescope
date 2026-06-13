from __future__ import annotations

import asyncio

import pytest

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
