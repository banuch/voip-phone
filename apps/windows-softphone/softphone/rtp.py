"""RTP media session: G.711 audio at 20 ms ptime and RFC 4733 DTMF."""
import random
import socket
import struct
import threading
import time
from collections import deque

import numpy as np

from . import g711

FRAME = 160  # 20 ms @ 8 kHz
DTMF_CODES = {**{str(i): i for i in range(10)}, '*': 10, '#': 11, 'A': 12, 'B': 13, 'C': 14, 'D': 15}
DTMF_CHARS = {v: k for k, v in DTMF_CODES.items()}


class RtpSession:
    def __init__(self, port_min=10000, port_max=20000):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for _ in range(50):
            try:
                self.sock.bind(('0.0.0.0', random.randrange(port_min, port_max, 2)))
                break
            except OSError:
                continue
        else:
            self.sock.bind(('0.0.0.0', 0))
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.remote = None
        self.pt = g711.PCMU
        self.dtmf_pt = None
        self.hold = False
        self.running = False
        self.latched = False
        self.ssrc = random.getrandbits(32)
        self.seq = random.getrandbits(16)
        self.ts = random.getrandbits(32)
        self.source = None
        self.sink = None
        self.on_dtmf = None
        self.tx_packets = 0
        self.rx_packets = 0
        self._dtmf_q = deque()
        self._dtmf_cur = None
        self._last_rx_dtmf_ts = None

    def set_remote(self, ip, port, pt, dtmf_pt):
        self.remote = (ip, port)
        if pt is not None:
            self.pt = pt
        self.dtmf_pt = dtmf_pt
        self.latched = False

    def start(self, source, sink):
        self.source, self.sink = source, sink
        if self.running:
            return
        self.running = True
        threading.Thread(target=self._tx_loop, name='rtp-tx', daemon=True).start()
        threading.Thread(target=self._rx_loop, name='rtp-rx', daemon=True).start()

    def close(self):
        self.running = False
        try:
            self.sock.close()
        except OSError:
            pass

    def send_dtmf(self, digit):
        code = DTMF_CODES.get(str(digit).upper())
        if code is not None:
            self._dtmf_q.append(code)

    # -- sending -------------------------------------------------------------
    def _send(self, pt, payload, marker=False, ts=None):
        hdr = struct.pack('!BBHII', 0x80, (0x80 if marker else 0) | pt, self.seq,
                          self.ts if ts is None else ts, self.ssrc)
        self.seq = (self.seq + 1) & 0xFFFF
        try:
            self.sock.sendto(hdr + payload, self.remote)
            self.tx_packets += 1
        except OSError:
            pass

    def _dtmf_step(self):
        cur = self._dtmf_cur
        if cur is None:
            cur = self._dtmf_cur = {'code': self._dtmf_q.popleft(), 'dur': 0, 'end': 0,
                                    'start': self.ts, 'ticks': 0}
        cur['ticks'] += 1
        if cur['end'] == 0:
            cur['dur'] += FRAME
            if cur['dur'] >= 8 * FRAME:   # 160 ms tone
                cur['end'] = 1
        else:
            cur['end'] += 1
        flags = (0x80 if cur['end'] else 0) | 10
        self._send(self.dtmf_pt, struct.pack('!BBH', cur['code'], flags, cur['dur']),
                   marker=cur['ticks'] == 1, ts=cur['start'])
        if cur['end'] >= 3:
            self.ts = (cur['start'] + (cur['ticks'] + 2) * FRAME) & 0xFFFFFFFF
            self._dtmf_cur = None

    def _tx_loop(self):
        nxt = time.perf_counter()
        while self.running:
            nxt += 0.02
            delay = nxt - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            elif delay < -0.2:
                nxt = time.perf_counter()
            try:
                frame = self.source() if self.source else None
            except Exception:
                frame = None
            if self.remote is None or self.hold or not self.running:
                self.ts = (self.ts + FRAME) & 0xFFFFFFFF
                continue
            if self.dtmf_pt is not None and (self._dtmf_cur or self._dtmf_q):
                self._dtmf_step()
                continue
            if frame is None:
                frame = np.zeros(FRAME, dtype=np.int16)
            self._send(self.pt, g711.encode(frame, self.pt))
            self.ts = (self.ts + FRAME) & 0xFFFFFFFF

    # -- receiving -----------------------------------------------------------
    def _rx_loop(self):
        while self.running:
            try:
                data, addr = self.sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if len(data) < 12 or data[0] >> 6 != 2:
                continue
            b0, b1 = data[0], data[1]
            off = 12 + 4 * (b0 & 0x0F)
            if b0 & 0x10:
                if len(data) < off + 4:
                    continue
                off += 4 + 4 * struct.unpack('!H', data[off + 2:off + 4])[0]
            end = len(data) - (data[-1] if b0 & 0x20 else 0)
            payload = data[off:end]
            pt = b1 & 0x7F
            self.rx_packets += 1
            # symmetric RTP: latch onto the address media really comes from (NAT)
            if not self.latched and self.remote and addr != self.remote:
                self.remote = addr
            self.latched = True
            if pt in (g711.PCMU, g711.PCMA):
                if self.sink:
                    self.sink(g711.decode(payload, pt))
            elif pt == self.dtmf_pt and len(payload) >= 4:
                ts = struct.unpack('!I', data[4:8])[0]
                if payload[1] & 0x80 and ts != self._last_rx_dtmf_ts:
                    self._last_rx_dtmf_ts = ts
                    if self.on_dtmf and payload[0] in DTMF_CHARS:
                        self.on_dtmf(DTMF_CHARS[payload[0]])
