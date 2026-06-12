"""CCSDS link-layer decode for the GOES HRIT/LRIT downlink.

The GNU Radio subprocess hands us the Viterbi-decoded bitstream; everything
from there to clean VCDUs happens here, in pure Python:

    bitstream → ASM frame sync (Deframer) → derandomize → RS(255,223) I=4 → VCDU

All of it is unit-testable with synthetic frames — see the encoder helpers
(`randomize`, `ReedSolomonCCSDS.encode`, `interleave_encode`) which exist so
tests and the simulator can build valid CADUs.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Attached Sync Marker that prefixes every CADU.
ASM = bytes((0x1A, 0xCF, 0xFC, 0x1D))
ASM_BITS = np.unpackbits(np.frombuffer(ASM, dtype=np.uint8))

# Frame geometry for the GOES LRIT/HRIT link: 8192-bit CADU = 32-bit ASM +
# 1020-byte randomized RS codeblock (4 interleaved RS(255,223) codewords).
FRAME_BYTES = 1024
CODEBLOCK_BYTES = 1020
RS_INTERLEAVE = 4
RS_N, RS_K = 255, 223
VCDU_BYTES = RS_INTERLEAVE * RS_K  # 892
FRAME_BITS = FRAME_BYTES * 8


# ── CCSDS pseudo-randomizer ──────────────────────────────────────────────

def _pn_sequence(length: int) -> bytes:
    """CCSDS randomizer sequence: h(x) = x^8+x^7+x^5+x^3+1, all-ones seed.

    First bytes are FF 48 0E C0 9A 0D 70 BC — the published CCSDS sequence.
    """
    state = [1] * 8
    out = bytearray()
    for _ in range(length):
        byte = 0
        for _ in range(8):
            bit = state[0]
            byte = (byte << 1) | bit
            fb = state[0] ^ state[3] ^ state[5] ^ state[7]
            state = state[1:] + [fb]
        out.append(byte)
    return bytes(out)


_PN = np.frombuffer(_pn_sequence(CODEBLOCK_BYTES), dtype=np.uint8)


def derandomize(codeblock: bytes) -> bytes:
    """XOR the CCSDS PN sequence over a codeblock (involution: also randomizes)."""
    data = np.frombuffer(codeblock, dtype=np.uint8)
    return (data ^ _PN[: data.size]).tobytes()


randomize = derandomize


# ── CRC-16/CCITT-FALSE (LRIT packet CRC) ─────────────────────────────────

def _build_crc_table() -> list[int]:
    table = []
    for byte in range(256):
        crc = byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
        table.append(crc)
    return table


_CRC_TABLE = _build_crc_table()


def crc16_ccitt(data: bytes, crc: int = 0xFFFF) -> int:
    for byte in data:
        crc = ((crc << 8) & 0xFFFF) ^ _CRC_TABLE[((crc >> 8) ^ byte) & 0xFF]
    return crc


# ── Reed-Solomon (255,223) — CCSDS dual-basis variant ────────────────────

# Berlekamp dual-basis ↔ conventional conversion matrix (libfec's tal[]).
_TAL = (0x8D, 0xEF, 0xEC, 0x86, 0xFA, 0x99, 0xAF, 0x7B)


def _build_basis_tables() -> tuple[bytes, bytes]:
    to_dual = bytearray(256)
    to_conv = bytearray(256)
    for i in range(256):
        v = 0
        for j in range(8):
            if i & (1 << j):
                v ^= _TAL[7 - j]
        to_dual[i] = v
        to_conv[v] = i
    return bytes(to_dual), bytes(to_conv)


_TO_DUAL, _TO_CONV = _build_basis_tables()


class ReedSolomonCCSDS:
    """RS(255,223) over GF(2^8), field poly 0x187, fcr=112, prim=11.

    Bytes on the wire are in Berlekamp's dual basis; we convert to the
    conventional basis, correct, and convert back. ``decode`` returns the
    corrected 255-byte codeword plus the number of corrected symbols, or
    ``None`` when the codeword is uncorrectable (> 16 symbol errors).
    """

    NROOTS = RS_N - RS_K  # 32
    FCR = 112
    PRIM = 11

    def __init__(self) -> None:
        # alpha = 2 is primitive for the CCSDS field polynomial 0x187.
        self.exp = [0] * 512
        self.log = [0] * 256
        x = 1
        for i in range(255):
            self.exp[i] = x
            self.log[x] = i
            x <<= 1
            if x & 0x100:
                x ^= 0x187
        if x != 1:
            raise RuntimeError("alpha=2 is not primitive for poly 0x187")
        for i in range(255, 512):
            self.exp[i] = self.exp[i - 255]

        # Generator polynomial with roots alpha^(PRIM*(FCR+i)), ascending degree.
        gen = [1]
        for i in range(self.NROOTS):
            root = self.exp[(self.PRIM * (self.FCR + i)) % 255]
            nxt = [0] * (len(gen) + 1)
            for d, coef in enumerate(gen):
                nxt[d] ^= self._mul(coef, root)
                nxt[d + 1] ^= coef
            gen = nxt
        self._genpoly = gen  # ascending degree, monic

    def _mul(self, a: int, b: int) -> int:
        if a == 0 or b == 0:
            return 0
        return self.exp[self.log[a] + self.log[b]]

    def _inv(self, a: int) -> int:
        return self.exp[255 - self.log[a]]

    # Codewords are byte arrays with index 0 = highest-degree coefficient
    # (first transmitted symbol), matching the CCSDS wire order.

    def encode(self, data: bytes) -> bytes:
        """Systematic encode of 223 dual-basis data bytes → 255-byte codeword."""
        if len(data) != RS_K:
            raise ValueError(f"RS encode expects {RS_K} bytes, got {len(data)}")
        msg = [_TO_CONV[b] for b in data]
        parity = [0] * self.NROOTS
        for sym in msg:
            feedback = sym ^ parity[0]
            parity = parity[1:] + [0]
            if feedback:
                flog = self.log[feedback]
                for d in range(self.NROOTS):
                    coef = self._genpoly[self.NROOTS - 1 - d]
                    if coef:
                        parity[d] ^= self.exp[flog + self.log[coef]]
        return bytes(data) + bytes(_TO_DUAL[p] for p in parity)

    def decode(self, codeword: bytes) -> tuple[bytes, int] | None:
        if len(codeword) != RS_N:
            raise ValueError(f"RS decode expects {RS_N} bytes, got {len(codeword)}")
        r = [_TO_CONV[b] for b in codeword]

        # Syndromes S_i = r(alpha^(PRIM*(FCR+i))) via Horner.
        syndromes = []
        any_nonzero = False
        for i in range(self.NROOTS):
            point = self.exp[(self.PRIM * (self.FCR + i)) % 255]
            acc = 0
            for sym in r:
                acc = self._mul(acc, point) ^ sym
            syndromes.append(acc)
            any_nonzero = any_nonzero or acc != 0
        if not any_nonzero:
            return bytes(codeword), 0

        # Berlekamp-Massey → error locator sigma (ascending degree).
        sigma = [1] + [0] * self.NROOTS
        prev = [1] + [0] * self.NROOTS
        L = 0
        m = 1
        b = 1
        for n in range(self.NROOTS):
            d = syndromes[n]
            for i in range(1, L + 1):
                d ^= self._mul(sigma[i], syndromes[n - i])
            if d == 0:
                m += 1
                continue
            coef = self._mul(d, self._inv(b))
            if 2 * L <= n:
                saved = sigma[:]
                for i in range(m, self.NROOTS + 1):
                    sigma[i] ^= self._mul(coef, prev[i - m])
                L = n + 1 - L
                prev = saved
                b = d
                m = 1
            else:
                for i in range(m, self.NROOTS + 1):
                    sigma[i] ^= self._mul(coef, prev[i - m])
                m += 1
        num_errors = L
        if num_errors > self.NROOTS // 2:
            return None
        sigma = sigma[: L + 1]
        if sigma[L] == 0:
            # Degree deficiency means BM didn't converge to a valid locator.
            return None

        # Chien search over all byte positions. Position j carries degree
        # 254-j, so its locator is X = alpha^(PRIM*(254-j)).
        error_positions = []
        error_locators = []
        for j in range(RS_N):
            x = self.exp[(self.PRIM * (254 - j)) % 255]
            x_inv = self._inv(x)
            acc = 0
            for d in range(len(sigma) - 1, -1, -1):
                acc = self._mul(acc, x_inv) ^ sigma[d]
            if acc == 0:
                error_positions.append(j)
                error_locators.append(x)
        if len(error_positions) != num_errors:
            return None

        # Forney: omega(x) = [S(x) * sigma(x)] mod x^NROOTS.
        omega = [0] * self.NROOTS
        for i in range(len(sigma)):
            for jj in range(self.NROOTS - i):
                omega[i + jj] ^= self._mul(sigma[i], syndromes[jj])

        corrected = list(r)
        for pos, x in zip(error_positions, error_locators):
            x_inv = self._inv(x)
            om = 0
            for d in range(self.NROOTS - 1, -1, -1):
                om = self._mul(om, x_inv) ^ omega[d]
            # sigma'(x_inv): derivative keeps odd-degree terms only.
            sp = 0
            for d in range(1, len(sigma), 2):
                term = sigma[d]
                for _ in range(d - 1):
                    term = self._mul(term, x_inv)
                sp ^= term
            if sp == 0:
                return None
            # Error magnitude Y = X^(1-FCR*PRIM... ) — with our syndrome
            # definition S_i = sum Y_l * X_l^(PRIM*(FCR+i)) the standard Forney
            # form is Y = X^(1 - b0) * omega(X^-1)/sigma'(X^-1) with
            # b0 = PRIM*FCR (in the exponent domain of X^PRIM steps folded in).
            exponent = (1 - self.FCR) % 255
            x_pow = self.exp[(self.log[x] * exponent) % 255] if exponent else 1
            magnitude = self._mul(self._mul(om, self._inv(sp)), x_pow)
            corrected[pos] ^= magnitude

        # Verify: all syndromes of the corrected word must vanish.
        for i in range(self.NROOTS):
            point = self.exp[(self.PRIM * (self.FCR + i)) % 255]
            acc = 0
            for sym in corrected:
                acc = self._mul(acc, point) ^ sym
            if acc != 0:
                return None

        return bytes(_TO_DUAL[s] for s in corrected), num_errors


_RS = ReedSolomonCCSDS()


def interleave_encode(vcdu: bytes) -> bytes:
    """Build a 1020-byte codeblock from an 892-byte VCDU (tests/simulator)."""
    if len(vcdu) != VCDU_BYTES:
        raise ValueError(f"VCDU must be {VCDU_BYTES} bytes, got {len(vcdu)}")
    codewords = [_RS.encode(bytes(vcdu[i::RS_INTERLEAVE])) for i in range(RS_INTERLEAVE)]
    out = bytearray(CODEBLOCK_BYTES)
    for i, cw in enumerate(codewords):
        out[i::RS_INTERLEAVE] = cw
    return bytes(out)


def interleave_decode(codeblock: bytes, *, rs_enabled: bool = True) -> tuple[bytes, int] | None:
    """Decode a 1020-byte codeblock → (892-byte VCDU, corrected symbol count).

    Returns ``None`` if any of the four interleaved codewords is
    uncorrectable. With ``rs_enabled=False`` the parity bytes are stripped
    without correction (cheap mode for underpowered hosts).
    """
    if len(codeblock) != CODEBLOCK_BYTES:
        raise ValueError(f"codeblock must be {CODEBLOCK_BYTES} bytes, got {len(codeblock)}")
    vcdu = bytearray(VCDU_BYTES)
    corrected_total = 0
    for i in range(RS_INTERLEAVE):
        cw = bytes(codeblock[i::RS_INTERLEAVE])
        if rs_enabled:
            result = _RS.decode(cw)
            if result is None:
                return None
            cw, corrected = result
            corrected_total += corrected
        vcdu[i::RS_INTERLEAVE] = cw[:RS_K]
    return bytes(vcdu), corrected_total


# ── Frame synchronizer ───────────────────────────────────────────────────

@dataclass
class DeframerStats:
    frames_total: int = 0
    frames_flywheel: int = 0
    sync_losses: int = 0
    searches: int = 0


class Deframer:
    """Locks onto the 32-bit ASM in a continuous decoded bitstream.

    Handles arbitrary bit alignment and BPSK 180° phase ambiguity (the
    convolutional code is transparent to inversion, so the Viterbi output may
    arrive complemented — we search for both the ASM and its complement and
    de-invert payloads). Once locked, frames are taken at the fixed stride
    with a short flywheel so a corrupted ASM doesn't immediately drop lock.
    """

    FLYWHEEL_LIMIT = 3

    def __init__(self) -> None:
        self._bits = np.zeros(0, dtype=np.uint8)
        self._locked = False
        self._inverted = False
        self._misses = 0
        self.stats = DeframerStats()

    @property
    def locked(self) -> bool:
        return self._locked

    def feed(self, chunk: bytes) -> list[bytes]:
        """Consume packed bytes from the pipeline; return derandomized-ready
        1020-byte codeblocks (ASM stripped, polarity corrected)."""
        if chunk:
            self._bits = np.concatenate(
                [self._bits, np.unpackbits(np.frombuffer(chunk, dtype=np.uint8))],
            )
        frames: list[bytes] = []
        while True:
            if not self._locked:
                if not self._search():
                    break
            frame = self._take_frame()
            if frame is None:
                break
            if frame is not _DROPPED:
                frames.append(frame)
        return frames

    def _search(self) -> bool:
        bits = self._bits
        if bits.size < ASM_BITS.size:
            return False
        self.stats.searches += 1
        window = bits.size - ASM_BITS.size + 1
        match = np.ones(window, dtype=bool)
        match_inv = np.ones(window, dtype=bool)
        for i, b in enumerate(ASM_BITS):
            seg = bits[i : i + window]
            match &= seg == b
            match_inv &= seg != b
        hits = np.flatnonzero(match)
        hits_inv = np.flatnonzero(match_inv)
        pos = -1
        if hits.size and (not hits_inv.size or hits[0] <= hits_inv[0]):
            pos, self._inverted = int(hits[0]), False
        elif hits_inv.size:
            pos, self._inverted = int(hits_inv[0]), True
        if pos < 0:
            # Keep the tail that could still hold a partial ASM.
            if bits.size > ASM_BITS.size - 1:
                self._bits = bits[-(ASM_BITS.size - 1):]
            return False
        self._bits = bits[pos:]
        self._locked = True
        self._misses = 0
        return True

    def _take_frame(self):
        if self._bits.size < FRAME_BITS:
            return None
        frame_bits = self._bits[:FRAME_BITS]
        if self._inverted:
            frame_bits = frame_bits ^ 1
        asm_ok = bool(np.array_equal(frame_bits[: ASM_BITS.size], ASM_BITS))
        if not asm_ok:
            self._misses += 1
            if self._misses > self.FLYWHEEL_LIMIT:
                self._locked = False
                self.stats.sync_losses += 1
                # Re-search from one bit past the failed lock point.
                self._bits = self._bits[1:]
                return _DROPPED
            self.stats.frames_flywheel += 1
        else:
            self._misses = 0
        self._bits = self._bits[FRAME_BITS:]
        self.stats.frames_total += 1
        return np.packbits(frame_bits[ASM_BITS.size :]).tobytes()


_DROPPED = object()


__all__ = (
    "ASM",
    "FRAME_BYTES",
    "CODEBLOCK_BYTES",
    "VCDU_BYTES",
    "derandomize",
    "randomize",
    "crc16_ccitt",
    "ReedSolomonCCSDS",
    "interleave_encode",
    "interleave_decode",
    "Deframer",
    "DeframerStats",
)
