"""End-to-end loopback test: two UAs on localhost, A calls B directly by IP.

Verifies INVITE/200/ACK, RTP audio both ways, voice-file mixing into the
outgoing stream, RFC 4733 DTMF, hold re-INVITE and BYE - without sound cards.

    python tests/loopback_test.py
"""
import os
import sys
import tempfile
import threading
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from softphone import g711  # noqa: E402
from softphone.audio import FilePlayer  # noqa: E402
from softphone.filedecode import load_audio_8k  # noqa: E402
from softphone.sip_message import SipMessage, build_auth, parse_auth  # noqa: E402
from softphone.sip_ua import SipUA  # noqa: E402


class Listener:
    def __init__(self, name, auto_answer=False):
        self.name = name
        self.ua = None
        self.auto_answer = auto_answer
        self.states = []
        self.received = []
        self.dtmf = []
        self.player = None
        self.ended = threading.Event()
        self.connected = threading.Event()

    def on_log(self, text):
        pass

    def on_reg_state(self, ok, text):
        print(f'[{self.name}] reg: {text}')

    def on_call_state(self, call):
        self.states.append(call.state)
        if call.state == 'connected':
            self.connected.set()
        if call.state == 'ended':
            print(f'[{self.name}] ended: {call.end_reason}')
            self.ended.set()

    def on_incoming_call(self, call):
        print(f'[{self.name}] incoming from {call.remote_number}')
        if self.auto_answer:
            threading.Timer(0.2, lambda: self.ua.answer(call)).start()

    def on_dtmf(self, call, digit):
        self.dtmf.append(digit)

    def on_media_start(self, call):
        def source():
            if self.player:
                f = self.player.read(160)
                if f is not None:
                    return f.astype(np.int16)
            return np.zeros(160, dtype=np.int16)
        call.rtp.start(source, lambda s: self.received.append(s))


def make_wav(path, seconds=1.0, rate=44100, freq=440):
    t = np.arange(int(rate * seconds)) / rate
    y = (np.sin(2 * np.pi * freq * t) * 12000).astype('<i2')
    stereo = np.repeat(y[:, None], 2, axis=1)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(stereo.tobytes())


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        check.failed = True


check.failed = False


def main():
    # codec round trip
    x = (np.sin(np.linspace(0, 50, 1600)) * 20000).astype(np.int16)
    for pt in (0, 8):
        err = np.abs(g711.decode(g711.encode(x, pt), pt).astype(int) - x).max()
        check(err < 700, f'G.711 pt={pt} round-trip max error {err}')

    # digest auth (RFC 2617 example)
    chal = parse_auth('Digest realm="testrealm@host.com", qop="auth", '
                      'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')
    hdr = build_auth('GET', '/dir/index.html', 'Mufasa', 'Circle Of Life', chal)
    check('nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"' in hdr and 'qop=auth' in hdr, 'digest header built')

    # message parsing with compact headers and folded Via
    m = SipMessage.parse(b'SIP/2.0 200 OK\r\nv: SIP/2.0/UDP a;branch=z9hG4bK1, SIP/2.0/UDP b;branch=z9\r\n'
                         b'i: abc\r\nl: 0\r\n\r\n')
    check(len(m.get_all('via')) == 2 and m.call_id == 'abc', 'parse compact + multi-value headers')

    tmp = tempfile.mkdtemp()
    wav = os.path.join(tmp, 'prompt.wav')
    make_wav(wav)
    samples = load_audio_8k(wav)
    check(abs(len(samples) - 8000) < 10, f'WAV 44.1k stereo decoded to 8k mono ({len(samples)} samples)')

    la, lb = Listener('A'), Listener('B', auto_answer=True)
    a, b = SipUA(la), SipUA(lb)
    la.ua, lb.ua = a, b
    a.start({}, local_port=5071)
    b.start({}, local_port=5072)
    try:
        la.player = FilePlayer(samples, 'prompt.wav')
        call = a.make_call(f'sip:bob@127.0.0.1:{b.local_port}')
        check(la.connected.wait(5) and lb.connected.wait(5), 'call connected on both sides')
        time.sleep(1.5)
        rx = np.concatenate(lb.received) if lb.received else np.zeros(1)
        rms = float(np.sqrt(np.mean(rx.astype(float) ** 2)))
        check(len(lb.received) > 30, f'B received {len(lb.received)} RTP frames')
        check(rms > 2000, f'B hears the voice file (rms {rms:.0f})')
        check(len(la.received) > 30, f'A received {len(la.received)} RTP frames from B')

        for d in '12#':
            a.send_dtmf(call, d)
        time.sleep(1.0)
        check(lb.dtmf == list('12#'), f'B received DTMF {lb.dtmf}')

        a.hold(call, True)
        time.sleep(0.5)
        bcall = b.active_call()
        check(bcall is not None and bcall.held_by_remote, 'hold re-INVITE: B sees call held')
        a.hold(call, False)
        time.sleep(0.5)
        check(bcall is not None and not bcall.held_by_remote, 'resume re-INVITE')

        a.hangup(call)
        check(lb.ended.wait(3), 'BYE ends the call on B')
    finally:
        a.stop()
        b.stop()
    print('\nRESULT:', 'FAILED' if check.failed else 'ALL TESTS PASSED')
    sys.exit(1 if check.failed else 0)


if __name__ == '__main__':
    main()
