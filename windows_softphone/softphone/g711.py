"""G.711 (PCMU / PCMA) codec using precomputed lookup tables."""
import numpy as np

PCMU = 0
PCMA = 8

_SEG_UEND = (0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF)
_SEG_AEND = (0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF)


def _search(val, table):
    for i, t in enumerate(table):
        if val <= t:
            return i
    return len(table)


def _lin2ulaw(pcm):
    pcm >>= 2
    if pcm < 0:
        pcm = -pcm
        mask = 0x7F
    else:
        mask = 0xFF
    if pcm > 8159:
        pcm = 8159
    pcm += 0x21
    seg = _search(pcm, _SEG_UEND)
    if seg >= 8:
        return 0x7F ^ mask
    return ((seg << 4) | ((pcm >> (seg + 1)) & 0xF)) ^ mask


def _ulaw2lin(u):
    u = ~u & 0xFF
    t = ((u & 0x0F) << 3) + 0x84
    t <<= (u & 0x70) >> 4
    return (0x84 - t) if (u & 0x80) else (t - 0x84)


def _lin2alaw(pcm):
    pcm >>= 3
    if pcm >= 0:
        mask = 0xD5
    else:
        mask = 0x55
        pcm = -pcm - 1
    seg = _search(pcm, _SEG_AEND)
    if seg >= 8:
        return 0x7F ^ mask
    aval = seg << 4
    aval |= ((pcm >> 1) & 0xF) if seg < 2 else ((pcm >> seg) & 0xF)
    return aval ^ mask


def _alaw2lin(a):
    a ^= 0x55
    t = (a & 0x0F) << 4
    seg = (a & 0x70) >> 4
    if seg == 0:
        t += 8
    elif seg == 1:
        t += 0x108
    else:
        t += 0x108
        t <<= seg - 1
    return t if (a & 0x80) else -t


_ENC = {
    PCMU: np.array([_lin2ulaw(i) for i in range(-32768, 32768)], dtype=np.uint8),
    PCMA: np.array([_lin2alaw(i) for i in range(-32768, 32768)], dtype=np.uint8),
}
_DEC = {
    PCMU: np.array([_ulaw2lin(i) for i in range(256)], dtype=np.int16),
    PCMA: np.array([_alaw2lin(i) for i in range(256)], dtype=np.int16),
}


def encode(samples, pt):
    """int16 numpy samples -> G.711 bytes."""
    idx = samples.astype(np.int32) + 32768
    return _ENC[pt][idx].tobytes()


def decode(payload, pt):
    """G.711 bytes -> int16 numpy samples."""
    return _DEC[pt][np.frombuffer(payload, dtype=np.uint8)]
