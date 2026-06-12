"""Unit tests for the pure-Python GOES decode chain (no hardware required)."""
from __future__ import annotations

import random

import numpy as np
import pytest

from rt_hardware.goes.ccsds import (
    ASM,
    Deframer,
    ReedSolomonCCSDS,
    _pn_sequence,
    crc16_ccitt,
    derandomize,
    interleave_decode,
    interleave_encode,
    randomize,
)
from rt_hardware.goes.encode import (
    build_lrit_file,
    build_space_packets,
    build_vcdus,
    encode_file_to_cadus,
)
from rt_hardware.goes.lrit import (
    FILE_TYPE_IMAGE,
    FILE_TYPE_TEXT,
    MpduAssembler,
    VirtualChannelDemux,
    parse_lrit_file,
    parse_vcdu,
)


# ─── Randomizer / CRC ──────────────────────────────────────────────────────


def test_pn_sequence_matches_published_ccsds_prefix():
    assert _pn_sequence(8).hex() == "ff480ec09a0d70bc"


def test_derandomize_is_an_involution():
    data = bytes(random.Random(3).randrange(256) for _ in range(1020))
    assert derandomize(randomize(data)) == data
    assert randomize(data) != data


def test_crc16_ccitt_check_value():
    # CRC-16/CCITT-FALSE standard check value.
    assert crc16_ccitt(b"123456789") == 0x29B1


# ─── Reed-Solomon ──────────────────────────────────────────────────────────


def test_rs_roundtrip_clean():
    rs = ReedSolomonCCSDS()
    data = bytes(range(223))
    codeword = rs.encode(data)
    assert rs.decode(codeword) == (codeword, 0)


@pytest.mark.parametrize("num_errors", [1, 5, 16])
def test_rs_corrects_up_to_16_symbol_errors(num_errors):
    rng = random.Random(num_errors)
    rs = ReedSolomonCCSDS()
    codeword = rs.encode(bytes(rng.randrange(256) for _ in range(223)))
    corrupted = bytearray(codeword)
    for pos in rng.sample(range(255), num_errors):
        corrupted[pos] ^= rng.randrange(1, 256)
    result = rs.decode(bytes(corrupted))
    assert result is not None
    assert result == (codeword, num_errors)


def test_rs_rejects_uncorrectable_codeword():
    rng = random.Random(99)
    rs = ReedSolomonCCSDS()
    corrupted = bytearray(rs.encode(bytes(223)))
    for pos in rng.sample(range(255), 40):
        corrupted[pos] ^= rng.randrange(1, 256)
    assert rs.decode(bytes(corrupted)) is None


def test_interleaved_codeblock_roundtrip_with_burst_error():
    rng = random.Random(7)
    vcdu = bytes(rng.randrange(256) for _ in range(892))
    codeblock = bytearray(interleave_encode(vcdu))
    # A 32-byte burst spreads across the 4 interleaved codewords (8 each).
    for pos in range(100, 132):
        codeblock[pos] ^= 0xA5
    result = interleave_decode(bytes(codeblock))
    assert result is not None
    assert result[0] == vcdu
    assert result[1] == 32


# ─── Deframer ──────────────────────────────────────────────────────────────


def _frame_stream(payloads: list[bytes]) -> bytes:
    return b"".join(ASM + p for p in payloads)


def test_deframer_locks_at_arbitrary_bit_offset():
    payloads = [bytes([i]) * 1020 for i in range(4)]
    stream = b"\x5a\xc3" + _frame_stream(payloads)
    bits = np.unpackbits(np.frombuffer(stream, np.uint8))[3:]  # 3-bit misalign
    packed = np.packbits(bits).tobytes()

    deframer = Deframer()
    out: list[bytes] = []
    for i in range(0, len(packed), 600):  # uneven chunking
        out.extend(deframer.feed(packed[i : i + 600]))
    assert out == payloads
    assert deframer.locked


def test_deframer_handles_bpsk_polarity_inversion():
    payloads = [bytes([i]) * 1020 for i in range(3)]
    inverted = bytes(b ^ 0xFF for b in _frame_stream(payloads))
    assert Deframer().feed(inverted) == payloads


def test_deframer_flywheels_through_one_corrupted_asm():
    payloads = [bytes([i]) * 1020 for i in range(5)]
    stream = bytearray()
    for i, p in enumerate(payloads):
        asm = bytearray(ASM)
        if i == 2:
            asm[1] ^= 0xFF
        stream += asm + p
    deframer = Deframer()
    out = deframer.feed(bytes(stream))
    assert out == payloads
    assert deframer.stats.frames_flywheel == 1
    assert deframer.stats.sync_losses == 0


# ─── LRIT layers ───────────────────────────────────────────────────────────


def test_vcdu_header_parse():
    vcdus = build_vcdus(5, build_space_packets(300, build_lrit_file(FILE_TYPE_TEXT, b"x" * 100)))
    header, mpdu = parse_vcdu(vcdus[0])
    assert header.vcid == 5
    assert header.counter == 0
    assert len(mpdu) == 886


def test_lrit_file_header_roundtrip():
    blob = build_lrit_file(
        FILE_TYPE_IMAGE, b"\x00" * 64, annotation="TEST_IMG.lrit", columns=8, lines=8,
    )
    parsed = parse_lrit_file(2, 50, blob)
    assert parsed is not None
    assert parsed.kind == "image"
    assert parsed.annotation == "TEST_IMG.lrit"
    assert (parsed.columns, parsed.lines, parsed.bits_per_pixel) == (8, 8, 8)
    assert parsed.data == b"\x00" * 64


def test_mpdu_assembler_resyncs_after_vcdu_gap():
    text = b"hello " * 2000
    packets = build_space_packets(77, build_lrit_file(FILE_TYPE_TEXT, text))
    vcdus = build_vcdus(3, packets)
    assert len(vcdus) > 3
    assembler = MpduAssembler(3)
    out = []
    for i, vcdu in enumerate(vcdus):
        if i == 1:
            continue  # drop a frame mid-file
        header, mpdu = parse_vcdu(vcdu)
        out.extend(assembler.feed(header.counter, mpdu))
    assert assembler.discontinuities == 1
    # The first packet (spanning the gap) is lost; later packets still parse.
    assert all(p.crc_ok for p in out)


def test_end_to_end_bitstream_to_products():
    text = b"GOES ADMIN TEXT MESSAGE\n" * 30
    image = bytes(range(256)) * 16  # 64x64
    stream = encode_file_to_cadus(0, 100, FILE_TYPE_TEXT, text, annotation="ADMIN.lrit")
    stream += encode_file_to_cadus(
        1, 200, FILE_TYPE_IMAGE, image, annotation="IMG.lrit", columns=64, lines=64,
    )
    # Invert + bit-shift the whole stream to exercise the demod-side ambiguities.
    bits = np.unpackbits(np.frombuffer(b"\x91" + stream, np.uint8))[5:]
    packed = bytes(b ^ 0xFF for b in np.packbits(bits).tobytes())

    deframer = Deframer()
    demux = VirtualChannelDemux()
    files = []
    for i in range(0, len(packed), 4096):
        for codeblock in deframer.feed(packed[i : i + 4096]):
            decoded = interleave_decode(derandomize(codeblock))
            assert decoded is not None
            files.extend(demux.feed(decoded[0]))

    assert [(f.kind, f.annotation) for f in files] == [("text", "ADMIN.lrit"), ("image", "IMG.lrit")]
    assert files[0].data == text
    assert files[1].data == image
    assert demux.packets_crc_err == 0
    assert demux.files_aborted == 0
