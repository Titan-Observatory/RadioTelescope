"""LRIT/HRIT transport + session layers: VCDU → M_PDU → space packets → files.

Implements the CCSDS / LRIT-HRIT Global Specification stack used by the GOES
downlink. Input is clean 892-byte VCDUs (post Reed-Solomon); output is
``LritFile`` objects carrying the parsed header records and the file data
field. Everything is incremental so it can run against a live stream.
"""
from __future__ import annotations

import logging
import struct
from dataclasses import dataclass, field

from rt_hardware.goes.ccsds import crc16_ccitt

logger = logging.getLogger(__name__)

VCID_FILL = 63
APID_IDLE = 2047
_FHP_NO_HEADER = 2047

# LRIT primary-header file type codes → product kinds.
FILE_TYPE_IMAGE = 0
FILE_TYPE_SERVICE_MESSAGE = 1
FILE_TYPE_TEXT = 2
FILE_TYPE_DCS = 130
FILE_TYPE_EMWIN = 214


@dataclass(frozen=True)
class VcduHeader:
    version: int
    scid: int
    vcid: int
    counter: int


def parse_vcdu(vcdu: bytes) -> tuple[VcduHeader, bytes]:
    """Split a VCDU into its 6-byte header and the M_PDU zone."""
    if len(vcdu) < 8:
        raise ValueError("VCDU too short")
    b0, b1 = vcdu[0], vcdu[1]
    header = VcduHeader(
        version=b0 >> 6,
        scid=((b0 & 0x3F) << 2) | (b1 >> 6),
        vcid=b1 & 0x3F,
        counter=int.from_bytes(vcdu[2:5], "big"),
    )
    return header, vcdu[6:]


@dataclass
class SpacePacket:
    apid: int
    sequence_flags: int  # 3 standalone, 1 first, 0 continuation, 2 last
    sequence_count: int
    data: bytes  # data field including the trailing CRC-16
    crc_ok: bool

    @property
    def payload(self) -> bytes:
        """Data field with the per-packet CRC-16 stripped."""
        return self.data[:-2] if len(self.data) >= 2 else b""


class MpduAssembler:
    """Reassembles CCSDS space packets from one virtual channel's M_PDUs.

    The first-header-pointer is only needed to (re)gain packet sync; once
    synced, packets are read back-to-back out of a rolling buffer. A gap in
    the VCDU counter discards the partial packet and waits for the next
    header pointer.
    """

    def __init__(self, vcid: int) -> None:
        self.vcid = vcid
        self._buffer = bytearray()
        self._synced = False
        self._last_counter: int | None = None
        self.packets_total = 0
        self.packets_crc_err = 0
        self.discontinuities = 0

    def feed(self, counter: int, mpdu: bytes) -> list[SpacePacket]:
        if len(mpdu) < 2:
            return []
        if self._last_counter is not None and counter != (self._last_counter + 1) % (1 << 24):
            self.discontinuities += 1
            self._buffer.clear()
            self._synced = False
        self._last_counter = counter

        fhp = ((mpdu[0] & 0x07) << 8) | mpdu[1]
        zone = mpdu[2:]

        if not self._synced:
            if fhp == _FHP_NO_HEADER or fhp >= len(zone):
                return []
            self._buffer = bytearray(zone[fhp:])
            self._synced = True
        else:
            self._buffer.extend(zone)

        packets: list[SpacePacket] = []
        while len(self._buffer) >= 6:
            length_field = (self._buffer[4] << 8) | self._buffer[5]
            total = 6 + length_field + 1
            if len(self._buffer) < total:
                break
            raw = bytes(self._buffer[:total])
            del self._buffer[:total]
            apid = ((raw[0] & 0x07) << 8) | raw[1]
            if apid == APID_IDLE:
                continue
            data = raw[6:]
            crc_ok = len(data) >= 2 and crc16_ccitt(data[:-2]) == int.from_bytes(data[-2:], "big")
            if not crc_ok:
                self.packets_crc_err += 1
            self.packets_total += 1
            packets.append(
                SpacePacket(
                    apid=apid,
                    sequence_flags=raw[2] >> 6,
                    sequence_count=((raw[2] & 0x3F) << 8) | raw[3],
                    data=data,
                    crc_ok=crc_ok,
                ),
            )
        return packets


@dataclass
class LritFile:
    vcid: int
    apid: int
    file_type: int
    data: bytes
    annotation: str | None = None
    columns: int | None = None
    lines: int | None = None
    bits_per_pixel: int | None = None
    compression: int | None = None
    segment: int | None = None
    segment_total: int | None = None
    noaa_product_id: int | None = None
    headers: dict[int, bytes] = field(default_factory=dict)

    @property
    def kind(self) -> str:
        if self.file_type == FILE_TYPE_IMAGE:
            return "image"
        if self.file_type in (FILE_TYPE_SERVICE_MESSAGE, FILE_TYPE_TEXT, FILE_TYPE_EMWIN):
            return "text"
        if self.file_type == FILE_TYPE_DCS:
            return "dcs"
        return "binary"


def parse_lrit_file(vcid: int, apid: int, blob: bytes) -> LritFile | None:
    """Parse the LRIT header records at the front of an assembled file."""
    if len(blob) < 16:
        return None
    header_type, record_length, file_type, total_header_length, _data_bits = struct.unpack(
        ">BHBIQ", blob[:16],
    )
    if header_type != 0 or record_length != 16:
        return None
    total_header_length = min(total_header_length, len(blob))

    out = LritFile(vcid=vcid, apid=apid, file_type=file_type, data=blob[total_header_length:])

    offset = 16
    while offset + 3 <= total_header_length:
        rec_type = blob[offset]
        rec_len = int.from_bytes(blob[offset + 1 : offset + 3], "big")
        if rec_len < 3 or offset + rec_len > total_header_length:
            break
        body = blob[offset + 3 : offset + rec_len]
        out.headers[rec_type] = body
        if rec_type == 1 and len(body) >= 6:  # image structure
            out.bits_per_pixel = body[0]
            out.columns = int.from_bytes(body[1:3], "big")
            out.lines = int.from_bytes(body[3:5], "big")
            out.compression = body[5]
        elif rec_type == 4:  # annotation (file name)
            out.annotation = body.decode("ascii", errors="replace").strip("\x00 ")
        elif rec_type == 128 and len(body) >= 14:  # NOAA segment identification
            out.segment = int.from_bytes(body[2:4], "big")
            out.segment_total = int.from_bytes(body[8:10], "big")
        elif rec_type == 129 and len(body) >= 6:  # NOAA LRIT header
            out.noaa_product_id = int.from_bytes(body[4:6], "big")
        offset += rec_len
    return out


class FileAssembler:
    """Assembles space packets (one virtual channel) into LRIT files.

    The first packet of a file carries a 10-byte transport header
    (u16 file counter + u64 file length); the session layer payload after it
    is the LRIT file itself.
    """

    def __init__(self, vcid: int) -> None:
        self.vcid = vcid
        self._partial: dict[int, bytearray] = {}
        self._last_seq: dict[int, int] = {}
        self.files_completed = 0
        self.files_aborted = 0

    def feed(self, packet: SpacePacket) -> list[LritFile]:
        if not packet.crc_ok:
            # A corrupted packet poisons the file being assembled on its APID.
            if packet.apid in self._partial:
                self._abort(packet.apid)
            return []

        apid = packet.apid
        flags = packet.sequence_flags
        files: list[LritFile] = []

        if flags in (1, 3):  # first / standalone
            if apid in self._partial:
                self._abort(apid)
            payload = packet.payload
            if len(payload) < 10:
                return []
            self._partial[apid] = bytearray(payload[10:])  # strip transport header
            self._last_seq[apid] = packet.sequence_count
            if flags == 3:
                files.extend(self._complete(apid))
            return files

        if apid not in self._partial:
            return []  # continuation without a start — mid-file join
        expected = (self._last_seq[apid] + 1) & 0x3FFF
        if packet.sequence_count != expected:
            self._abort(apid)
            return []
        self._last_seq[apid] = packet.sequence_count
        self._partial[apid].extend(packet.payload)
        if flags == 2:  # last
            files.extend(self._complete(apid))
        return files

    def _complete(self, apid: int) -> list[LritFile]:
        blob = bytes(self._partial.pop(apid))
        self._last_seq.pop(apid, None)
        parsed = parse_lrit_file(self.vcid, apid, blob)
        if parsed is None:
            self.files_aborted += 1
            logger.debug("VC%d APID %d: discarding unparseable %d-byte file", self.vcid, apid, len(blob))
            return []
        self.files_completed += 1
        return [parsed]

    def _abort(self, apid: int) -> None:
        self._partial.pop(apid, None)
        self._last_seq.pop(apid, None)
        self.files_aborted += 1


class VirtualChannelDemux:
    """Top of the stack: VCDUs in, LRIT files out, with per-VC counters."""

    def __init__(self) -> None:
        self._mpdu: dict[int, MpduAssembler] = {}
        self._files: dict[int, FileAssembler] = {}
        self.vcdu_total = 0
        self.vcdu_fill = 0
        self.vcdu_counts: dict[int, int] = {}

    def feed(self, vcdu: bytes) -> list[LritFile]:
        header, mpdu = parse_vcdu(vcdu)
        self.vcdu_total += 1
        if header.vcid == VCID_FILL:
            self.vcdu_fill += 1
            return []
        self.vcdu_counts[header.vcid] = self.vcdu_counts.get(header.vcid, 0) + 1
        assembler = self._mpdu.setdefault(header.vcid, MpduAssembler(header.vcid))
        file_assembler = self._files.setdefault(header.vcid, FileAssembler(header.vcid))
        files: list[LritFile] = []
        for packet in assembler.feed(header.counter, mpdu):
            files.extend(file_assembler.feed(packet))
        return files

    @property
    def packets_total(self) -> int:
        return sum(a.packets_total for a in self._mpdu.values())

    @property
    def packets_crc_err(self) -> int:
        return sum(a.packets_crc_err for a in self._mpdu.values())

    @property
    def files_completed(self) -> int:
        return sum(a.files_completed for a in self._files.values())

    @property
    def files_aborted(self) -> int:
        return sum(a.files_aborted for a in self._files.values())


__all__ = (
    "VcduHeader",
    "parse_vcdu",
    "SpacePacket",
    "MpduAssembler",
    "LritFile",
    "parse_lrit_file",
    "FileAssembler",
    "VirtualChannelDemux",
    "VCID_FILL",
    "FILE_TYPE_IMAGE",
    "FILE_TYPE_TEXT",
    "FILE_TYPE_DCS",
    "FILE_TYPE_EMWIN",
)
