"""Decode voice files to 8 kHz mono int16 for playback into calls.

Supported: WAV (PCM, A-law, u-law), MP3, FLAC, OGG Vorbis (via miniaudio),
plus raw telephony prompts: .ulaw/.alaw (G.711) and .sln/.raw/.pcm (8 kHz s16le).
"""
import os
import wave

import numpy as np

from . import g711
from .audio import resample_rate

try:
    import miniaudio
except Exception:  # pragma: no cover
    miniaudio = None

FILE_TYPES = [
    ('Audio files', '*.wav *.mp3 *.flac *.ogg *.ulaw *.ul *.alaw *.al *.sln *.raw *.pcm'),
    ('All files', '*.*'),
]


def load_audio_8k(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.ulaw', '.ul', '.mu', '.pcmu'):
        with open(path, 'rb') as f:
            return g711.decode(f.read(), g711.PCMU).copy()
    if ext in ('.alaw', '.al', '.pcma'):
        with open(path, 'rb') as f:
            return g711.decode(f.read(), g711.PCMA).copy()
    if ext in ('.sln', '.raw', '.pcm'):
        with open(path, 'rb') as f:
            data = f.read()
        return np.frombuffer(data[:len(data) - len(data) % 2], dtype='<i2').copy()
    if miniaudio is not None:
        try:
            dec = miniaudio.decode_file(path, output_format=miniaudio.SampleFormat.SIGNED16,
                                        nchannels=1, sample_rate=8000)
            return np.array(dec.samples, dtype=np.int16)
        except Exception:
            if ext != '.wav':
                raise
    if ext == '.wav':
        return _load_wav(path)
    raise ValueError(f'Unsupported audio format: {ext or "unknown"}')


def _load_wav(path):
    with wave.open(path, 'rb') as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width == 1:
        x = (np.frombuffer(raw, np.uint8).astype(np.float32) - 128.0) * 256.0
    elif width == 2:
        x = np.frombuffer(raw, '<i2').astype(np.float32)
    elif width == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3).astype(np.int32)
        x = (((b[:, 2] << 24) | (b[:, 1] << 16) | (b[:, 0] << 8)) >> 16).astype(np.float32)
    elif width == 4:
        x = (np.frombuffer(raw, '<i4') >> 16).astype(np.float32)
    else:
        raise ValueError(f'Unsupported WAV sample width: {width}')
    x = x[:len(x) - len(x) % ch].reshape(-1, ch).mean(axis=1)
    x = resample_rate(x, rate, 8000)
    return np.clip(x, -32768, 32767).astype(np.int16)
