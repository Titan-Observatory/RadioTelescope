"""Minimal asyncio client for goesrecv's nanomsg publishers.

goesrecv publishes over nanomsg PUB sockets (TCP transport). The SP-over-TCP
protocol is tiny — an 8-byte header exchange followed by length-prefixed
messages — so we implement it directly rather than pulling in a nanomsg/nng
binding (none ships wheels for every Pi variant; goesrecv-monitor takes the
same approach):

* connect, send ``00 53 50 00 00 21 00 00`` ("\\0SP\\0" + protocol SUB=0x21)
* peer replies ``00 53 50 00 00 20 00 00`` (PUB=0x20)
* each message is then ``uint64 big-endian length`` + payload

PUB/SUB topic filtering is client-side in nanomsg, and goesrecv publishes
without topics, so every received message is payload.
"""
from __future__ import annotations

import asyncio

_SUB_HELLO = bytes((0x00, 0x53, 0x50, 0x00, 0x00, 0x21, 0x00, 0x00))
_PUB_HELLO = bytes((0x00, 0x53, 0x50, 0x00, 0x00, 0x20, 0x00, 0x00))

# Symbol batches are the largest messages goesrecv sends (a second of int8
# I/Q at HRIT rate is ~1.9 MB); anything beyond this is a framing error.
_MAX_MESSAGE = 16 * 1024 * 1024


class NanomsgProtocolError(RuntimeError):
    pass


class NanomsgSubscriber:
    """One SUB connection to a ``tcp://host:port`` nanomsg PUB endpoint."""

    def __init__(self, url: str, *, connect_timeout_s: float = 5.0) -> None:
        if not url.startswith("tcp://"):
            raise ValueError(f"Only tcp:// endpoints are supported, got {url!r}")
        host, _, port = url[len("tcp://"):].rpartition(":")
        self._host = host
        self._port = int(port)
        self._connect_timeout_s = connect_timeout_s
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

    async def connect(self) -> None:
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self._host, self._port),
            timeout=self._connect_timeout_s,
        )
        self._writer.write(_SUB_HELLO)
        await self._writer.drain()
        hello = await asyncio.wait_for(
            self._reader.readexactly(len(_PUB_HELLO)),
            timeout=self._connect_timeout_s,
        )
        # Validate the SP magic; accept any peer protocol number so a future
        # goesrecv/nanomsg revision doesn't spuriously kill the stream.
        if hello[:4] != _PUB_HELLO[:4]:
            raise NanomsgProtocolError(f"Bad nanomsg handshake from {self._host}:{self._port}: {hello.hex()}")

    async def recv(self) -> bytes:
        """Read one message; raises IncompleteReadError when the peer closes."""
        if self._reader is None:
            raise RuntimeError("subscriber is not connected")
        header = await self._reader.readexactly(8)
        length = int.from_bytes(header, "big")
        if length > _MAX_MESSAGE:
            raise NanomsgProtocolError(f"Implausible message length {length}")
        return await self._reader.readexactly(length)

    async def close(self) -> None:
        writer = self._writer
        self._reader = None
        self._writer = None
        if writer is None:
            return
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

    async def __aenter__(self) -> "NanomsgSubscriber":
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()


__all__ = ("NanomsgSubscriber", "NanomsgProtocolError")
