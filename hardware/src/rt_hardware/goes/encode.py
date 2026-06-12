"""Builders that fabricate valid GOES downlink data (the inverse of the
decode chain). Used by the unit tests and the simulate backend — never on the
real signal path.

    LRIT file bytes → space packets → M_PDUs/VCDUs → randomized RS codeblocks
    → ASM-framed CADU bitstream
"""
from __future__ import annotations

import struct

from rt_hardware.goes.ccsds import ASM, VCDU_BYTES, crc16_ccitt, interleave_encode, randomize

_PACKET_MAX_PAYLOAD = 4000  # well under the 8190-byte CCSDS limit


def build_lrit_file(
    file_type: int,
    data: bytes,
    *,
    annotation: str | None = None,
    columns: int | None = None,
    lines: int | None = None,
    bits_per_pixel: int = 8,
    compression: int = 0,
) -> bytes:
    """Assemble LRIT header records + data field into raw file bytes."""
    records: list[bytes] = []
    if columns is not None and lines is not None:
        body = bytes([bits_per_pixel]) + struct.pack(">HHB", columns, lines, compression)
        records.append(bytes([1]) + (len(body) + 3).to_bytes(2, "big") + body)
    if annotation is not None:
        body = annotation.encode("ascii")
        records.append(bytes([4]) + (len(body) + 3).to_bytes(2, "big") + body)
    total_header_length = 16 + sum(len(r) for r in records)
    primary = struct.pack(">BHBIQ", 0, 16, file_type, total_header_length, len(data) * 8)
    return primary + b"".join(records) + data


def build_space_packets(apid: int, file_bytes: bytes, *, start_seq: int = 0) -> list[bytes]:
    """Split an LRIT file into CRC-stamped CCSDS space packets.

    Prepends the 10-byte transport header (file counter + length) to the
    session payload, exactly as the satellite does.
    """
    session = struct.pack(">HQ", 1, len(file_bytes)) + file_bytes
    chunks = [session[i : i + _PACKET_MAX_PAYLOAD] for i in range(0, len(session), _PACKET_MAX_PAYLOAD)]
    packets: list[bytes] = []
    for i, chunk in enumerate(chunks):
        if len(chunks) == 1:
            flags = 3
        elif i == 0:
            flags = 1
        elif i == len(chunks) - 1:
            flags = 2
        else:
            flags = 0
        data = chunk + crc16_ccitt(chunk).to_bytes(2, "big")
        seq = (start_seq + i) & 0x3FFF
        header = struct.pack(
            ">HHH",
            apid & 0x7FF,
            (flags << 14) | seq,
            len(data) - 1,
        )
        packets.append(header + data)
    return packets


def build_vcdus(vcid: int, packets: list[bytes], *, scid: int = 0x21, start_counter: int = 0) -> list[bytes]:
    """Pack a back-to-back packet stream into 892-byte VCDUs with M_PDU headers."""
    stream = b"".join(packets)
    packet_starts = set()
    pos = 0
    for p in packets:
        packet_starts.add(pos)
        pos += len(p)

    zone_size = VCDU_BYTES - 6 - 2  # 884-byte packet zone
    vcdus: list[bytes] = []
    offset = 0
    counter = start_counter
    while offset < len(stream):
        zone = stream[offset : offset + zone_size]
        pad = zone_size - len(zone)
        if pad >= 7:
            # Fill the tail of the final frame with a real idle packet
            # (APID 2047) so the assembler skips it instead of mis-parsing.
            idle = struct.pack(">HHH", 0x7FF, 3 << 14, pad - 7) + b"\x00" * (pad - 6)
            zone += idle
        elif pad:
            # Too small for a packet header; the assembler leaves these bytes
            # unconsumed, which is harmless at end-of-stream.
            zone += b"\x00" * pad
        fhp = 2047
        for i in range(min(zone_size, len(stream) - offset)):
            if (offset + i) in packet_starts:
                fhp = i
                break
        b0 = (0 << 6) | ((scid >> 2) & 0x3F)
        b1 = ((scid & 0x03) << 6) | (vcid & 0x3F)
        header = bytes([b0, b1]) + counter.to_bytes(3, "big") + b"\x00"
        mpdu_header = ((fhp >> 8) & 0x07).to_bytes(1, "big") + (fhp & 0xFF).to_bytes(1, "big")
        vcdus.append(header + mpdu_header + zone)
        offset += zone_size
        counter = (counter + 1) % (1 << 24)
    return vcdus


def build_cadus(vcdus: list[bytes]) -> bytes:
    """RS-encode, randomize and ASM-frame VCDUs into a transmittable byte stream."""
    out = bytearray()
    for vcdu in vcdus:
        codeblock = randomize(interleave_encode(vcdu))
        out += ASM + codeblock
    return bytes(out)


def encode_file_to_cadus(
    vcid: int,
    apid: int,
    file_type: int,
    data: bytes,
    **lrit_kwargs,
) -> bytes:
    """One-call helper: LRIT file content → CADU byte stream."""
    file_bytes = build_lrit_file(file_type, data, **lrit_kwargs)
    packets = build_space_packets(apid, file_bytes)
    return build_cadus(build_vcdus(vcid, packets))


__all__ = (
    "build_lrit_file",
    "build_space_packets",
    "build_vcdus",
    "build_cadus",
    "encode_file_to_cadus",
)
