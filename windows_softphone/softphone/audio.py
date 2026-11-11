"""Sound-card I/O, voice-file player and call-progress tones.

All call audio is handled internally as 8 kHz mono samples in int16 scale
(stored as float32). The sound card runs at its own native rate and is
resampled at the edges.
"""
import threading

import numpy as np

try:
    import sounddevice as sd
except Exception:  # pragma: no cover - missing PortAudio
    sd = None

RATE = 8000
FRAME = 160


def resample(x, n_out):
    n_in = len(x)
    if n_in == n_out:
        return x
    if n_in == 0 or n_out == 0:
        return np.zeros(n_out, dtype=np.float32)
    if n_in % n_out == 0:  # integer decimation with a box filter
        return x.reshape(n_out, -1).mean(axis=1)
    return np.interp(np.linspace(0, n_in - 1, n_out), np.arange(n_in), x).astype(np.float32)


def resample_rate(x, rate_in, rate_out):
    if rate_in == rate_out or len(x) == 0:
        return x.astype(np.float32)
    n_out = int(round(len(x) * rate_out / rate_in))
    if rate_out < rate_in:  # crude low-pass before decimating
        k = max(1, int(rate_in // (rate_out * 0.9)))
        if k > 1:
            x = np.convolve(x, np.ones(k) / k, mode='same')
    return resample(np.asarray(x, dtype=np.float32), n_out)


class SampleFifo:
    """Thread-safe sample FIFO with a size cap and optional pre-fill (jitter buffer)."""

    def __init__(self, max_samples, prefill=0):
        self.max = max_samples
        self.prefill = prefill
        self.buf = np.zeros(0, dtype=np.float32)
        self.lock = threading.Lock()
        self.starving = prefill > 0

    def push(self, x):
        with self.lock:
            self.buf = np.concatenate((self.buf, np.asarray(x, dtype=np.float32)))
            if len(self.buf) > self.max:
                self.buf = self.buf[-self.max:]

    def pop(self, n):
        with self.lock:
            if self.starving:
                if len(self.buf) < self.prefill:
                    return np.zeros(n, dtype=np.float32)
                self.starving = False
            out = self.buf[:n]
            self.buf = self.buf[n:]
            if len(out) < n:
                if self.prefill:
                    self.starving = True
                out = np.concatenate((out, np.zeros(n - len(out), dtype=np.float32)))
            return out

    def clear(self):
        with self.lock:
            self.buf = np.zeros(0, dtype=np.float32)
            self.starving = self.prefill > 0


class FilePlayer:
    """Feeds a decoded voice file (8 kHz int16) frame by frame."""

    def __init__(self, samples, name='', loop=False, gain=1.0, on_done=None):
        self.data = np.asarray(samples, dtype=np.float32)
        self.name = name
        self.loop = loop
        self.gain = gain
        self.on_done = on_done
        self.pos = 0
        self.active = len(self.data) > 0

    @property
    def progress(self):
        return self.pos / len(self.data) if len(self.data) else 1.0

    @property
    def duration(self):
        return len(self.data) / RATE

    def stop(self):
        self.active = False
        self.on_done = None

    def read(self, n):
        if not self.active:
            return None
        out = np.zeros(n, dtype=np.float32)
        filled = 0
        while filled < n:
            remain = len(self.data) - self.pos
            if remain <= 0:
                if self.loop:
                    self.pos = 0
                    continue
                self.active = False
                break
            k = min(n - filled, remain)
            out[filled:filled + k] = self.data[self.pos:self.pos + k]
            self.pos += k
            filled += k
        if not self.active and self.on_done:
            cb, self.on_done = self.on_done, None
            cb()
        return out * self.gain


def _pick_rate(device, kind):
    check = sd.check_input_settings if kind == 'input' else sd.check_output_settings
    for rate in (48000, 44100, 16000, 8000):
        try:
            check(device=device, samplerate=rate, channels=1, dtype='float32')
            return rate
        except Exception:
            continue
    return int(sd.query_devices(device, kind)['default_samplerate'])


class AudioEngine:
    def __init__(self):
        self.input_device = None
        self.output_device = None
        self.mic = SampleFifo(1600)                    # <=200 ms mic latency
        self.spk = SampleFifo(2400, prefill=480)       # 60 ms jitter pre-fill
        self.monitor = SampleFifo(4000)
        self.player = None
        self.mute = False
        self.mute_mic_while_playing = True
        self.monitor_file = True
        self.mic_gain = 1.0
        self.spk_gain = 1.0
        self.in_stream = None
        self.out_stream = None
        self.in_rate = self.out_rate = RATE
        self.out_channels = 1
        self.errors = []
        self.lock = threading.Lock()

    @property
    def running(self):
        return self.in_stream is not None or self.out_stream is not None

    def start(self):
        with self.lock:
            if self.running:
                return
            self.errors = []
            self.mic.clear()
            self.spk.clear()
            self.monitor.clear()
            if sd is None:
                self.errors.append('sounddevice / PortAudio is not available')
                return
            try:
                self.in_rate = _pick_rate(self.input_device, 'input')
                self.in_stream = sd.InputStream(device=self.input_device, channels=1, samplerate=self.in_rate,
                                                dtype='float32', blocksize=self.in_rate // 50,
                                                callback=self._in_cb)
                self.in_stream.start()
            except Exception as e:
                self.in_stream = None
                self.errors.append(f'Microphone: {e}')
            try:
                self.out_rate = _pick_rate(self.output_device, 'output')
                for ch in (1, 2):
                    try:
                        self.out_stream = sd.OutputStream(device=self.output_device, channels=ch,
                                                          samplerate=self.out_rate, dtype='float32',
                                                          blocksize=self.out_rate // 50, callback=self._out_cb)
                        self.out_channels = ch
                        break
                    except Exception:
                        if ch == 2:
                            raise
                self.out_stream.start()
            except Exception as e:
                self.out_stream = None
                self.errors.append(f'Speaker: {e}')

    def stop(self):
        with self.lock:
            for s in (self.in_stream, self.out_stream):
                if s is not None:
                    try:
                        s.stop()
                        s.close()
                    except Exception:
                        pass
            self.in_stream = self.out_stream = None

    def stop_player(self):
        p, self.player = self.player, None
        if p:
            p.stop()

    # -- sound card callbacks -------------------------------------------------
    def _in_cb(self, indata, frames, _time, _status):
        x = indata[:, 0] * (32767.0 * self.mic_gain)
        self.mic.push(resample(x, int(round(frames * RATE / self.in_rate))))

    def _out_cb(self, outdata, frames, _time, _status):
        n8 = int(round(frames * RATE / self.out_rate))
        s = self.spk.pop(n8) * self.spk_gain + self.monitor.pop(n8)
        y = np.clip(resample(s, frames) / 32768.0, -1.0, 1.0)
        outdata[:] = y.reshape(-1, 1)

    # -- RTP hooks --------------------------------------------------------------
    def next_tx_frame(self):
        """Called by the RTP sender every 20 ms; returns the mixed outgoing frame."""
        mic = self.mic.pop(FRAME)
        p = self.player
        fp = p.read(FRAME) if p else None
        if self.mute or (fp is not None and self.mute_mic_while_playing):
            mic = np.zeros(FRAME, dtype=np.float32)
        out = mic
        if fp is not None:
            out = mic + fp
            if self.monitor_file and self.out_stream is not None:
                self.monitor.push(fp)
        return np.clip(out, -32768, 32767).astype(np.int16)

    def push_remote(self, samples):
        if self.out_stream is not None:
            self.spk.push(samples)


# -- device listing / simple playback ------------------------------------------

def _hostapi():
    try:
        out = sd.default.device[1]
        if out is None or out < 0:
            return 0
        return sd.query_devices(out)['hostapi']
    except Exception:
        return 0


def list_devices():
    if sd is None:
        return [], []
    try:
        devs = sd.query_devices()
    except Exception:
        return [], []
    api = _hostapi()
    ins = [d['name'] for d in devs if d['max_input_channels'] > 0 and d['hostapi'] == api]
    outs = [d['name'] for d in devs if d['max_output_channels'] > 0 and d['hostapi'] == api]
    return ins, outs


def resolve_device(name, kind):
    if not name or sd is None:
        return None
    api = _hostapi()
    try:
        for i, d in enumerate(sd.query_devices()):
            if d['name'] == name and d[f'max_{kind}_channels'] > 0 and d['hostapi'] == api:
                return i
    except Exception:
        pass
    return None


def play_buffer(samples8k, device=None, loop=False):
    """Play 8 kHz int16-scale samples on the speaker (preview / ring tones)."""
    if sd is None or samples8k is None or len(samples8k) == 0:
        return
    try:
        rate = _pick_rate(device, 'output')
        y = resample_rate(np.asarray(samples8k, dtype=np.float32), RATE, rate) / 32768.0
        sd.play(np.clip(y, -1, 1).astype(np.float32), rate, device=device, loop=loop)
    except Exception:
        pass


def stop_buffer():
    if sd is not None:
        try:
            sd.stop()
        except Exception:
            pass


def _tone(freqs, seconds, amp=6000):
    t = np.arange(int(RATE * seconds)) / RATE
    if not freqs:
        return np.zeros(len(t), dtype=np.float32)
    y = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
    return (y * amp).astype(np.float32)


def make_ringback():
    return np.concatenate([_tone((400, 450), 0.4), _tone(None, 0.2), _tone((400, 450), 0.4), _tone(None, 2.0)])


def make_ringtone():
    burst = np.concatenate([np.concatenate([_tone((1000,), 0.05, 9000), _tone((1250,), 0.05, 9000)])
                            for _ in range(8)])
    return np.concatenate([burst, _tone(None, 0.25), burst, _tone(None, 2.0)])
