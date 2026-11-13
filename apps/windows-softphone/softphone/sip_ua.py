"""SIP user agent over UDP: registration, calls, hold, transfer and DTMF.

The listener object receives callbacks (from network threads):
    on_log(text)
    on_reg_state(ok, text)          ok: True / False / None (neutral)
    on_call_state(call)
    on_incoming_call(call)
    on_media_start(call)            start audio and call.rtp.start(...)
    on_dtmf(call, digit)
"""
import socket
import threading
import time
import traceback

from . import APP_NAME, APP_VERSION
from .rtp import RtpSession
from .sdp import CODEC_NAMES, build_sdp, choose_codec, parse_sdp
from .sip_message import (SipMessage, build_auth, gen_branch, gen_call_id, gen_tag, get_tag,
                          parse_auth, parse_name_addr, parse_uri, parse_via, random_session_id)

USER_AGENT = f'{APP_NAME}/{APP_VERSION}'
ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, NOTIFY, REFER, MESSAGE'
T1 = 0.5
DTMF_PT = 101


class ClientTx:
    def __init__(self, request, dest, cb):
        self.request = request
        self.branch = parse_via(request.get('via'))[2].get('branch')
        self.method = request.method
        self.data = request.serialize()
        self.dest = dest
        self.cb = cb
        self.interval = T1
        self.next = time.monotonic() + T1
        self.started = time.monotonic()
        self.count = 0
        self.provisional = False
        self.done = False


class Call:
    def __init__(self, direction):
        self.id = ''
        self.direction = direction            # 'in' / 'out'
        self.state = 'new'                    # calling, ringing, incoming, connected, ended
        self.local_tag = gen_tag()
        self.remote_tag = None
        self.local_hdr = ''                   # our From/To header value (with tag)
        self.remote_hdr = ''                  # their From/To header value
        self.remote_target = ''
        self.route_set = []
        self.local_cseq = 0
        self.invite_req = None
        self.uas_addr = None
        self.uas_resp = None
        self.uas_200_retx = None
        self.ack_data = None
        self.ack_dest = None
        self.dialed = ''
        self.remote_number = ''
        self.remote_name = ''
        self.rtp = None
        self.remote_sdp = None
        self.codec_pt = None
        self.sess_id = random_session_id()
        self.sdp_version = 0
        self.on_hold = False
        self.held_by_remote = False
        self.cancelled = False
        self.provisional = False
        self.media_started = False
        self.refer_pending = False
        self.created = time.time()
        self.connected_at = None
        self.ended_at = None
        self.end_reason = ''

    @property
    def codec_name(self):
        return CODEC_NAMES.get(self.codec_pt, '')

    def __repr__(self):
        return f'<Call {self.direction} {self.remote_number} {self.state}>'


class SipUA:
    def __init__(self, listener):
        self.listener = listener
        self.lock = threading.RLock()
        self.sock = None
        self.running = False
        self.account = {}
        self.codecs = [0, 8]
        self.server_addr = None
        self.server_host = ''
        self.local_ip = '127.0.0.1'
        self.local_port = 0
        self.public_addr = None
        self.txs = {}
        self.calls = {}
        self.timers = []
        self.threads = []
        self.registered = False
        self.reg_call_id = None
        self.reg_tag = None
        self.reg_cseq = 0
        self.reg_next = None
        self.reg_generation = 0
        self._unreg_event = None
        self._last_keepalive = 0

    # =========================================================================
    # lifecycle
    # =========================================================================
    def start(self, account, codecs=None, local_port=None):
        self.account = dict(account or {})
        if codecs:
            self.codecs = list(codecs)
        port = int(local_port if local_port is not None else self.account.get('local_port') or 5060)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.sock.bind(('0.0.0.0', port))
        except OSError:
            self.sock.bind(('0.0.0.0', 0))
        self.sock.settimeout(0.5)
        self.local_port = self.sock.getsockname()[1]
        self.public_addr = None
        self.registered = False
        self.reg_call_id = None
        self.reg_generation += 1

        host, sport = self._split_hostport(self.account.get('proxy') or self.account.get('domain') or '')
        self.server_host = host
        self.server_addr = None
        error = None
        if host:
            try:
                self.server_addr = (socket.gethostbyname(host), sport or 5060)
            except OSError as e:
                error = f'Cannot resolve {host}: {e}'
        self.local_ip = self._detect_local_ip(self.server_addr[0] if self.server_addr else '8.8.8.8')
        self.running = True
        self.threads = [threading.Thread(target=self._recv_loop, name='sip-recv', daemon=True),
                        threading.Thread(target=self._timer_loop, name='sip-timer', daemon=True)]
        for t in self.threads:
            t.start()
        self._log(f'SIP listening on {self.local_ip}:{self.local_port}')
        if error:
            self.listener.on_reg_state(False, error)
        elif self.server_addr and self.account.get('username') and self.account.get('register', True):
            self.listener.on_reg_state(None, 'Registering…')
            with self.lock:
                self.register()
        elif self.server_addr:
            self.listener.on_reg_state(True, f'Ready (no registration) – {host}')
        else:
            self.listener.on_reg_state(None, f'No account – direct IP calls on {self.local_ip}:{self.local_port}')

    def stop(self):
        if not self.running:
            return
        with self.lock:
            for call in list(self.calls.values()):
                if call.state != 'ended':
                    self.hangup(call)
            if self.registered:
                self._unreg_event = threading.Event()
                self.register(expires=0)
            ev = self._unreg_event
        if ev:
            ev.wait(1.5)
        self.running = False
        try:
            self.sock.close()
        except OSError:
            pass
        for t in self.threads:
            t.join(timeout=1.0)
        self.txs.clear()
        self.timers.clear()
        self.registered = False

    # =========================================================================
    # helpers
    # =========================================================================
    @staticmethod
    def _split_hostport(value):
        value = (value or '').strip()
        if value.lower().startswith('sip:'):
            value = value[4:]
        if ':' in value:
            h, p = value.rsplit(':', 1)
            return h, int(p) if p.isdigit() else None
        return value, None

    @staticmethod
    def _detect_local_ip(remote):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((remote, 5060))
            return s.getsockname()[0]
        except OSError:
            return '127.0.0.1'
        finally:
            s.close()

    def _log(self, text):
        try:
            self.listener.on_log(text)
        except Exception:
            pass

    def _send(self, data, addr):
        try:
            self.sock.sendto(data, addr)
            self._log(f'--> {addr[0]}:{addr[1]}\n{data.decode("utf-8", "replace")}')
        except OSError as e:
            self._log(f'send error to {addr}: {e}')

    def schedule(self, delay, fn):
        with self.lock:
            self.timers.append((time.monotonic() + delay, fn))

    @property
    def domain(self):
        return self.account.get('domain') or self.server_host or self.local_ip

    @property
    def aor(self):
        user = self.account.get('username') or 'anonymous'
        return f'sip:{user}@{self.domain}'

    def _contact_uri(self):
        ip, port = self.public_addr or (self.local_ip, self.local_port)
        user = self.account.get('username')
        return f'sip:{user}@{ip}:{port}' if user else f'sip:{ip}:{port}'

    def _from_hdr(self, tag):
        disp = (self.account.get('display_name') or '').replace('"', '')
        name = f'"{disp}" ' if disp else ''
        return f'{name}<{self.aor}>;tag={tag}'

    def _via(self):
        return f'SIP/2.0/UDP {self.local_ip}:{self.local_port};rport;branch={gen_branch()}'

    def _new_request(self, method, ruri, from_hdr, to_hdr, call_id, cseq, routes=()):
        m = SipMessage.request(method, ruri)
        m.add('Via', self._via())
        m.add('Max-Forwards', '70')
        for r in routes:
            m.add('Route', r)
        m.add('From', from_hdr)
        m.add('To', to_hdr)
        m.add('Call-ID', call_id)
        m.add('CSeq', f'{cseq} {method}')
        m.add('User-Agent', USER_AGENT)
        return m

    def _resolve(self, host, port):
        return socket.gethostbyname(host), port or 5060

    def _dest_for_request(self, msg):
        if self.server_addr:
            return self.server_addr
        routes = msg.get_all('route')
        uri = parse_name_addr(routes[0])[1] if routes else msg.uri
        _, _, host, port, _ = parse_uri(uri)
        return self._resolve(host, port)

    def normalize_target(self, target):
        t = target.strip()
        if t.lower().startswith(('sip:', 'sips:')):
            return t
        if '@' in t:
            return 'sip:' + t
        domain = self.account.get('domain') or self.server_host
        if domain:
            t = ''.join(ch for ch in t if ch not in ' -()') if t.replace(' ', '').replace('-', '').lstrip('+').isdigit() else t
            return f'sip:{t}@{domain}'
        return f'sip:{t}'   # bare IP / host for direct calls

    def active_call(self):
        for c in self.calls.values():
            if c.state != 'ended':
                return c
        return None

    # =========================================================================
    # transaction layer
    # =========================================================================
    def send_request(self, msg, cb, dest=None):
        dest = dest or self._dest_for_request(msg)
        if msg.method == 'ACK':
            self._send(msg.serialize(), dest)
            return None
        tx = ClientTx(msg, dest, cb)
        self.txs[tx.branch] = tx
        self._send(tx.data, dest)
        return tx

    def _send_auth(self, msg, cb, cseq_hook=None, attempts=0):
        def on_resp(resp):
            if (resp is not None and resp.status in (401, 407) and attempts < 2
                    and self.account.get('password')):
                hdr = 'www-authenticate' if resp.status == 401 else 'proxy-authenticate'
                chal = parse_auth(resp.get(hdr) or '')
                if chal.get('nonce'):
                    new = msg.copy()
                    new.set('Via', self._via())
                    num, method = msg.cseq
                    new.set('CSeq', f'{num + 1} {method}')
                    user = self.account.get('auth_user') or self.account.get('username', '')
                    auth = build_auth(method, msg.uri, user, self.account['password'], chal)
                    new.set('Authorization' if resp.status == 401 else 'Proxy-Authorization', auth)
                    if cseq_hook:
                        cseq_hook(num + 1, new)
                    self._send_auth(new, cb, cseq_hook, attempts + 1)
                    return
            cb(resp)
        try:
            self.send_request(msg, on_resp)
        except OSError as e:
            self._log(f'Cannot send {msg.method}: {e}')
            cb(None)

    def _handle_response(self, resp):
        branch = parse_via(resp.get('via'))[2].get('branch')
        tx = self.txs.get(branch)
        if tx is None:
            # retransmitted 2xx to INVITE -> re-send our ACK
            if resp.cseq[1] == 'INVITE' and 200 <= resp.status < 300:
                call = self.calls.get(resp.call_id)
                if call and call.ack_data:
                    self._send(call.ack_data, call.ack_dest)
            return
        if resp.status < 200:
            tx.provisional = True
            tx.cb(resp)
            return
        tx.done = True
        self.txs.pop(branch, None)
        if tx.method == 'INVITE' and resp.status >= 300:
            self._ack_non_2xx(tx, resp)
        tx.cb(resp)

    def _ack_non_2xx(self, tx, resp):
        req = tx.request
        ack = SipMessage.request('ACK', req.uri)
        ack.add('Via', req.get('via'))
        ack.add('Max-Forwards', '70')
        for r in req.get_all('route'):
            ack.add('Route', r)
        ack.add('From', req.get('from'))
        ack.add('To', resp.get('to'))
        ack.add('Call-ID', req.call_id)
        ack.add('CSeq', f'{req.cseq[0]} ACK')
        ack.add('User-Agent', USER_AGENT)
        self._send(ack.serialize(), tx.dest)

    def _respond(self, req, addr, code, reason, to_tag=None, contact=False, body=None,
                 ctype='application/sdp', extra=()):
        r = SipMessage.response(code, reason)
        for v in req.get_all('via'):
            r.add('Via', v)
        if req.method == 'INVITE' and 100 < code < 300:
            for rr in req.get_all('record-route'):
                r.add('Record-Route', rr)
        r.add('From', req.get('from'))
        to = req.get('to')
        if to_tag and not get_tag(to) and code > 100:
            to += f';tag={to_tag}'
        r.add('To', to)
        r.add('Call-ID', req.call_id)
        r.add('CSeq', req.get('cseq'))
        r.add('User-Agent', USER_AGENT)
        if contact:
            r.add('Contact', f'<{self._contact_uri()}>')
        for n, v in extra:
            r.add(n, v)
        if body:
            r.add('Content-Type', ctype)
            r.body = body
        data = r.serialize()
        self._send(data, addr)
        return data

    # =========================================================================
    # network / timer threads
    # =========================================================================
    def _recv_loop(self):
        while self.running:
            try:
                data, addr = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data.strip():
                continue  # keep-alive
            try:
                msg = SipMessage.parse(data)
            except Exception as e:
                self._log(f'Unparseable message from {addr}: {e}')
                continue
            self._log(f'<-- {addr[0]}:{addr[1]}\n{data.decode("utf-8", "replace")}')
            with self.lock:
                try:
                    if msg.is_request:
                        self._handle_request(msg, addr)
                    else:
                        self._handle_response(msg)
                except Exception:
                    self._log('Error handling message:\n' + traceback.format_exc())

    def _timer_loop(self):
        while self.running:
            time.sleep(0.05)
            with self.lock:
                try:
                    self._on_timer()
                except Exception:
                    self._log('Timer error:\n' + traceback.format_exc())

    def _on_timer(self):
        now = time.monotonic()
        for tx in list(self.txs.values()):
            if tx.done:
                continue
            if tx.provisional and tx.method == 'INVITE':
                if now - tx.started > 180:
                    tx.done = True
                    self.txs.pop(tx.branch, None)
                    tx.cb(None)
                continue
            if now >= tx.next:
                if tx.count >= 7:
                    tx.done = True
                    self.txs.pop(tx.branch, None)
                    tx.cb(None)
                    continue
                self._send(tx.data, tx.dest)
                tx.count += 1
                tx.interval = tx.interval * 2 if tx.method == 'INVITE' else min(tx.interval * 2, 4.0)
                if tx.provisional:
                    tx.interval = 4.0
                tx.next = now + tx.interval
        for call in list(self.calls.values()):
            r = call.uas_200_retx
            if r and now >= r[0]:
                if r[2] >= 7:
                    call.uas_200_retx = None
                else:
                    self._send(call.uas_resp, call.uas_addr)
                    call.uas_200_retx = [now + min(r[1] * 2, 4.0), min(r[1] * 2, 4.0), r[2] + 1]
        if self.reg_next and now >= self.reg_next:
            self.reg_next = None
            self.register()
        if self.registered and self.server_addr and now - self._last_keepalive > 25:
            self._last_keepalive = now
            try:
                self.sock.sendto(b'\r\n\r\n', self.server_addr)
            except OSError:
                pass
        due = [t for t in self.timers if t[0] <= now]
        if due:
            self.timers = [t for t in self.timers if t[0] > now]
            for _, fn in due:
                fn()

    # =========================================================================
    # registration
    # =========================================================================
    def register(self, expires=None):
        if not self.server_addr or not self.account.get('username'):
            return
        if expires is None:
            expires = int(self.account.get('expires') or 300)
        if not self.reg_call_id:
            self.reg_call_id = gen_call_id(self.local_ip)
            self.reg_tag = gen_tag()
        self.reg_cseq += 1
        aor = self.aor
        m = self._new_request('REGISTER', f'sip:{self.domain}', self._from_hdr(self.reg_tag),
                              f'<{aor}>', self.reg_call_id, self.reg_cseq)
        m.add('Contact', f'<{self._contact_uri()}>')
        m.add('Expires', str(expires))
        m.add('Allow', ALLOW)
        gen = self.reg_generation

        def hook(n, _new):
            self.reg_cseq = n

        self._send_auth(m, lambda r: self._on_register(r, expires, gen), cseq_hook=hook)

    def _on_register(self, resp, expires, gen):
        if gen != self.reg_generation or not self.running:
            return
        if resp is None:
            self.registered = False
            self.listener.on_reg_state(False, 'Registration timeout – retrying')
            if expires:
                self.schedule(30, self.register)
            elif self._unreg_event:
                self._unreg_event.set()
            return
        if 200 <= resp.status < 300:
            if expires == 0:
                self.registered = False
                self.listener.on_reg_state(None, 'Unregistered')
                if self._unreg_event:
                    self._unreg_event.set()
                return
            _, _, vp = parse_via(resp.get('via'))
            if self.account.get('nat', True) and ('received' in vp or vp.get('rport')):
                rp = vp.get('rport')
                pub = (vp.get('received') or self.local_ip,
                       int(rp) if rp and rp.isdigit() else self.local_port)
                current = self.public_addr or (self.local_ip, self.local_port)
                if pub != current:
                    self._log(f'NAT detected, public address {pub[0]}:{pub[1]} – re-registering')
                    self.public_addr = pub
                    self.register(expires)
                    return
            granted = expires
            for c in resp.get_all('contact'):
                e = parse_name_addr(c)[2].get('expires')
                if e and e.isdigit():
                    granted = int(e)
                    break
            else:
                e = resp.get('expires')
                if e and e.isdigit():
                    granted = int(e)
            self.registered = True
            user = self.account.get('username')
            self.listener.on_reg_state(True, f'Registered – {user}@{self.domain}')
            self.reg_next = time.monotonic() + max(granted * 0.8, 10)
        else:
            self.registered = False
            if self._unreg_event and expires == 0:
                self._unreg_event.set()
                return
            self.listener.on_reg_state(False, f'Registration failed: {resp.status} {resp.reason}')
            self.schedule(60, self.register)

    # =========================================================================
    # outgoing calls
    # =========================================================================
    def make_call(self, target):
        with self.lock:
            if not self.running:
                raise RuntimeError('SIP stack is not running')
            if self.active_call():
                raise RuntimeError('A call is already in progress')
            ruri = self.normalize_target(target)
            call = Call('out')
            call.id = gen_call_id(self.local_ip)
            call.dialed = target.strip()
            call.remote_target = ruri
            disp, user = '', parse_uri(ruri)[1]
            call.remote_number = user or parse_uri(ruri)[2]
            call.remote_name = disp
            call.local_hdr = self._from_hdr(call.local_tag)
            call.remote_hdr = f'<{ruri}>'
            call.rtp = RtpSession()
            call.local_cseq = 1
            m = self._new_request('INVITE', ruri, call.local_hdr, call.remote_hdr, call.id, 1)
            m.add('Contact', f'<{self._contact_uri()}>')
            m.add('Allow', ALLOW)
            m.add('Content-Type', 'application/sdp')
            m.body = self._local_sdp(call, self.codecs, DTMF_PT)
            call.invite_req = m
            call.state = 'calling'
            self.calls[call.id] = call

            def hook(n, new):
                call.local_cseq = n
                call.invite_req = new

            self.listener.on_call_state(call)
            self._send_auth(m, lambda r: self._on_invite_resp(call, r), cseq_hook=hook)
            return call

    def _local_sdp(self, call, codecs, dtmf_pt, direction='sendrecv'):
        call.sdp_version += 1
        return build_sdp(self.local_ip, call.rtp.port, codecs, dtmf_pt, direction,
                         call.sess_id, call.sdp_version)

    def _on_invite_resp(self, call, r):
        if r is None:
            if call.state != 'ended':
                self._end_call(call, 'No response from server')
            return
        st = r.status
        if st < 200:
            if call.state == 'ended':
                return
            if st > 100:
                call.provisional = True
            if st in (180, 183) and call.state in ('calling', 'ringing'):
                call.state = 'ringing'
                if r.body and 'sdp' in (r.get('content-type') or '').lower():
                    self._apply_remote_sdp(call, r.body)
                    self._start_media(call)
                self.listener.on_call_state(call)
            return
        if st < 300:
            call.remote_hdr = r.get('to')
            call.remote_tag = get_tag(call.remote_hdr)
            contact = r.get('contact')
            if contact:
                call.remote_target = parse_name_addr(contact)[1]
            call.route_set = list(reversed(r.get_all('record-route')))
            disp = parse_name_addr(call.remote_hdr)[0]
            if disp:
                call.remote_name = disp
            self._send_ack(call, r.cseq[0])
            if call.cancelled or call.state == 'ended':
                self._send_bye(call)
                return
            if r.body:
                self._apply_remote_sdp(call, r.body)
            call.state = 'connected'
            call.connected_at = time.time()
            self._start_media(call)
            self.listener.on_call_state(call)
            return
        if call.state != 'ended':
            self._end_call(call, 'Cancelled' if call.cancelled else f'{st} {r.reason}')

    def _send_ack(self, call, cseq):
        ack = self._new_request('ACK', call.remote_target, call.local_hdr, call.remote_hdr,
                                call.id, cseq, call.route_set)
        call.ack_data = ack.serialize()
        call.ack_dest = self._dest_for_request(ack)
        self._send(call.ack_data, call.ack_dest)

    def _apply_remote_sdp(self, call, body, parsed=None):
        sdp = parsed or parse_sdp(body)
        if not sdp['ip'] or not sdp['port']:
            return
        call.remote_sdp = sdp
        pt = choose_codec(sdp, self.codecs)
        if pt is None:
            pt = next((p for p in sdp['payloads'] if p in CODEC_NAMES), None)
        if pt is not None:
            call.codec_pt = pt
        call.held_by_remote = sdp['direction'] in ('sendonly', 'inactive') or sdp['ip'] == '0.0.0.0'
        call.rtp.set_remote(sdp['ip'], sdp['port'], call.codec_pt, sdp['dtmf_pt'])

    def _start_media(self, call):
        if call.media_started or call.rtp is None:
            return
        call.media_started = True
        call.rtp.on_dtmf = lambda d: self.listener.on_dtmf(call, d)
        try:
            self.listener.on_media_start(call)
        except Exception:
            self._log('Media start error:\n' + traceback.format_exc())

    def _end_call(self, call, reason):
        if call.state == 'ended':
            return
        call.state = 'ended'
        call.end_reason = reason
        call.ended_at = time.time()
        call.uas_200_retx = None
        if call.rtp:
            call.rtp.close()
        self.listener.on_call_state(call)

        def purge():
            if self.calls.get(call.id) is call:
                del self.calls[call.id]
        self.schedule(32, purge)

    # =========================================================================
    # call control
    # =========================================================================
    def _dialog_request(self, call, method):
        call.local_cseq += 1
        return self._new_request(method, call.remote_target, call.local_hdr, call.remote_hdr,
                                 call.id, call.local_cseq, call.route_set)

    def _cseq_hook(self, call):
        def hook(n, _new):
            call.local_cseq = n
        return hook

    def _send_bye(self, call):
        m = self._dialog_request(call, 'BYE')
        self._send_auth(m, lambda r: None, cseq_hook=self._cseq_hook(call))

    def _send_cancel(self, call):
        inv = call.invite_req
        c = SipMessage.request('CANCEL', inv.uri)
        c.add('Via', inv.get('via'))
        c.add('Max-Forwards', '70')
        for r in inv.get_all('route'):
            c.add('Route', r)
        c.add('From', inv.get('from'))
        c.add('To', inv.get('to'))
        c.add('Call-ID', inv.call_id)
        c.add('CSeq', f'{inv.cseq[0]} CANCEL')
        c.add('User-Agent', USER_AGENT)
        self.send_request(c, lambda r: None)

    def hangup(self, call=None):
        with self.lock:
            call = call or self.active_call()
            if not call or call.state == 'ended':
                return
            if call.direction == 'out' and call.state in ('calling', 'ringing'):
                call.cancelled = True
                self._send_cancel(call)
                self._end_call(call, 'Cancelled')
            elif call.direction == 'in' and call.state == 'incoming':
                self.reject(call)
            else:
                self._send_bye(call)
                self._end_call(call, 'Call ended')

    def reject(self, call, code=486, reason='Busy Here'):
        with self.lock:
            if call.state != 'incoming':
                return
            call.uas_resp = self._respond(call.invite_req, call.uas_addr, code, reason, to_tag=call.local_tag)
            self._end_call(call, 'Rejected')

    def answer(self, call):
        with self.lock:
            if call.state != 'incoming':
                return
            remote = call.remote_sdp
            if remote and remote['port']:
                pt = choose_codec(remote, self.codecs)
                body = self._local_sdp(call, [pt], remote['dtmf_pt'])
                self._apply_remote_sdp(call, None, parsed=remote)
            else:
                body = self._local_sdp(call, self.codecs, DTMF_PT)
            data = self._respond(call.invite_req, call.uas_addr, 200, 'OK', to_tag=call.local_tag,
                                 contact=True, body=body, extra=[('Allow', ALLOW)])
            call.uas_resp = data
            call.uas_200_retx = [time.monotonic() + T1, T1, 0]
            call.state = 'connected'
            call.connected_at = time.time()
            self._start_media(call)
            self.listener.on_call_state(call)

    def hold(self, call, on):
        with self.lock:
            if call.state != 'connected' or call.on_hold == on:
                return
            call.on_hold = on
            call.rtp.hold = on
            m = self._dialog_request(call, 'INVITE')
            m.add('Contact', f'<{self._contact_uri()}>')
            m.add('Allow', ALLOW)
            m.add('Content-Type', 'application/sdp')
            dtmf = call.remote_sdp['dtmf_pt'] if call.remote_sdp else DTMF_PT
            m.body = self._local_sdp(call, [call.codec_pt or self.codecs[0]], dtmf,
                                     'sendonly' if on else 'sendrecv')

            def cb(r):
                if r is not None and 200 <= r.status < 300:
                    self._send_ack(call, r.cseq[0])
                    if r.body:
                        self._apply_remote_sdp(call, r.body)
                elif r is not None and r.status >= 300:
                    self._log(f'Hold/resume rejected: {r.status} {r.reason}')
                self.listener.on_call_state(call)

            self._send_auth(m, cb, cseq_hook=self._cseq_hook(call))
            self.listener.on_call_state(call)

    def transfer(self, call, target):
        with self.lock:
            if call.state != 'connected':
                return
            ruri = self.normalize_target(target)
            m = self._dialog_request(call, 'REFER')
            m.add('Contact', f'<{self._contact_uri()}>')
            m.add('Refer-To', f'<{ruri}>')
            m.add('Referred-By', f'<{self.aor}>')
            call.refer_pending = True

            def cb(r):
                if r is None or r.status >= 300:
                    call.refer_pending = False
                    self._log(f'Transfer failed: {r.status if r else "timeout"}')
                else:
                    self._log('Transfer accepted')

            self._send_auth(m, cb, cseq_hook=self._cseq_hook(call))

    def send_dtmf(self, call, digit):
        with self.lock:
            if call.state != 'connected':
                return
            if call.rtp.dtmf_pt is not None:
                call.rtp.send_dtmf(digit)
            else:  # SIP INFO fallback
                m = self._dialog_request(call, 'INFO')
                m.add('Content-Type', 'application/dtmf-relay')
                m.body = f'Signal={digit}\r\nDuration=160\r\n'.encode()
                self._send_auth(m, lambda r: None, cseq_hook=self._cseq_hook(call))

    # =========================================================================
    # incoming requests
    # =========================================================================
    def _handle_request(self, req, addr):
        method = req.method
        call = self.calls.get(req.call_id)
        if method == 'INVITE':
            self._on_invite(req, addr, call)
        elif method == 'ACK':
            if call:
                call.uas_200_retx = None
                if req.body and call.state == 'connected' and not call.remote_sdp:
                    self._apply_remote_sdp(call, req.body)
        elif method == 'BYE':
            if call:
                self._respond(req, addr, 200, 'OK')
                self._end_call(call, 'Remote party hung up')
            else:
                self._respond(req, addr, 481, 'Call/Transaction Does Not Exist')
        elif method == 'CANCEL':
            if call:
                self._respond(req, addr, 200, 'OK')
                if call.state == 'incoming':
                    call.uas_resp = self._respond(call.invite_req, call.uas_addr, 487,
                                                  'Request Terminated', to_tag=call.local_tag)
                    self._end_call(call, 'Caller cancelled')
            else:
                self._respond(req, addr, 481, 'Call/Transaction Does Not Exist')
        elif method == 'OPTIONS':
            self._respond(req, addr, 200, 'OK', extra=[('Allow', ALLOW), ('Accept', 'application/sdp')])
        elif method == 'NOTIFY':
            self._respond(req, addr, 200, 'OK')
            if call and call.refer_pending and req.body:
                body = req.body.decode('utf-8', 'replace')
                if 'SIP/2.0 2' in body:
                    call.refer_pending = False
                    self._log('Transfer completed')
                    if call.state != 'ended':
                        self._send_bye(call)
                        self._end_call(call, 'Transferred')
                elif any(f'SIP/2.0 {c}' in body for c in '3456'):
                    call.refer_pending = False
                    self._log('Transfer target failed: ' + body.strip())
        elif method == 'INFO':
            self._respond(req, addr, 200, 'OK')
            body = req.body.decode('utf-8', 'replace')
            if call and 'Signal=' in body:
                digit = body.split('Signal=', 1)[1].split()[0].strip()
                self.listener.on_dtmf(call, digit[:1])
        elif method == 'MESSAGE':
            self._respond(req, addr, 200, 'OK')
            self._log(f'MESSAGE from {req.get("from")}: {req.body.decode("utf-8", "replace")}')
        else:
            self._respond(req, addr, 501, 'Not Implemented')

    def _on_invite(self, req, addr, call):
        to_tag = get_tag(req.get('to'))
        if call:
            if to_tag and call.state != 'ended':
                self._on_reinvite(call, req, addr)
            elif call.uas_resp:
                self._send(call.uas_resp, addr)   # retransmission
            return
        if to_tag:
            self._respond(req, addr, 481, 'Call/Transaction Does Not Exist')
            return
        if self.active_call():
            self._respond(req, addr, 486, 'Busy Here')
            self._log(f'Rejected call from {req.get("from")} (busy)')
            return
        sdp = parse_sdp(req.body) if req.body else None
        if sdp and sdp['port'] and choose_codec(sdp, self.codecs) is None:
            self._respond(req, addr, 488, 'Not Acceptable Here')
            return
        call = Call('in')
        call.id = req.call_id
        call.invite_req = req
        call.uas_addr = addr
        call.remote_hdr = req.get('from')
        call.remote_tag = get_tag(call.remote_hdr)
        call.local_hdr = f'{req.get("to")};tag={call.local_tag}'
        contact = req.get('contact')
        call.remote_target = parse_name_addr(contact or call.remote_hdr)[1]
        call.route_set = req.get_all('record-route')
        call.local_cseq = 100
        disp, uri, _ = parse_name_addr(call.remote_hdr)
        _, user, host, _, _ = parse_uri(uri)
        call.remote_name = disp
        call.remote_number = user or host
        call.dialed = user or uri
        call.rtp = RtpSession()
        call.remote_sdp = sdp
        call.state = 'incoming'
        self.calls[call.id] = call
        self._respond(req, addr, 100, 'Trying')
        call.uas_resp = self._respond(req, addr, 180, 'Ringing', to_tag=call.local_tag, contact=True)
        self.listener.on_incoming_call(call)

    def _on_reinvite(self, call, req, addr):
        if req.body:
            self._apply_remote_sdp(call, req.body)
        sdp = call.remote_sdp or {}
        rdir = sdp.get('direction', 'sendrecv')
        if rdir == 'inactive' or call.held_by_remote and call.on_hold:
            direction = 'inactive'
        elif rdir == 'sendonly':
            direction = 'recvonly'
        elif call.on_hold:
            direction = 'sendonly'
        else:
            direction = 'sendrecv'
        body = self._local_sdp(call, [call.codec_pt or self.codecs[0]], sdp.get('dtmf_pt'), direction)
        call.invite_req = req
        call.uas_addr = addr
        call.uas_resp = self._respond(req, addr, 200, 'OK', contact=True, body=body,
                                      extra=[('Allow', ALLOW)])
        call.uas_200_retx = [time.monotonic() + T1, T1, 0]
        self.listener.on_call_state(call)
