"""SIP message parsing / serialisation and helpers (RFC 3261 subset)."""
import hashlib
import os
import random
import re

_COMPACT = {
    'v': 'via', 'f': 'from', 't': 'to', 'i': 'call-id', 'm': 'contact',
    'l': 'content-length', 'c': 'content-type', 'k': 'supported',
    's': 'subject', 'o': 'event', 'r': 'refer-to', 'b': 'referred-by',
    'e': 'content-encoding', 'u': 'allow-events',
}
_CANON = {
    'call-id': 'Call-ID', 'cseq': 'CSeq', 'www-authenticate': 'WWW-Authenticate',
    'proxy-authenticate': 'Proxy-Authenticate', 'proxy-authorization': 'Proxy-Authorization',
}
# headers whose comma-separated values are split into separate entries
_SPLIT = {'via', 'route', 'record-route'}


def canon(name):
    return _CANON.get(name) or '-'.join(p[:1].upper() + p[1:] for p in name.split('-'))


def split_commas(value):
    out, cur, depth, quoted = [], '', 0, False
    for ch in value:
        if ch == '"':
            quoted = not quoted
        elif not quoted and ch == '<':
            depth += 1
        elif not quoted and ch == '>':
            depth -= 1
        if ch == ',' and not quoted and depth == 0:
            if cur.strip():
                out.append(cur.strip())
            cur = ''
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


class SipMessage:
    def __init__(self):
        self.method = None
        self.uri = None
        self.status = 0
        self.reason = ''
        self.headers = []
        self.body = b''

    # -- construction -----------------------------------------------------
    @classmethod
    def request(cls, method, uri):
        m = cls()
        m.method = method
        m.uri = uri
        return m

    @classmethod
    def response(cls, status, reason):
        m = cls()
        m.status = status
        m.reason = reason
        return m

    @classmethod
    def parse(cls, data):
        sep = data.find(b'\r\n\r\n')
        if sep >= 0:
            head, body = data[:sep], data[sep + 4:]
        else:
            sep = data.find(b'\n\n')
            head, body = (data[:sep], data[sep + 2:]) if sep >= 0 else (data, b'')
        lines = head.decode('utf-8', 'replace').replace('\r\n', '\n').split('\n')
        while lines and not lines[0].strip():
            lines.pop(0)
        if not lines:
            raise ValueError('empty message')
        msg = cls()
        start = lines[0].strip()
        if start.upper().startswith('SIP/2.0'):
            parts = start.split(None, 2)
            msg.status = int(parts[1])
            msg.reason = parts[2] if len(parts) > 2 else ''
        else:
            parts = start.split()
            if len(parts) < 3:
                raise ValueError('bad request line')
            msg.method = parts[0].upper()
            msg.uri = parts[1]
        raw = []
        for line in lines[1:]:
            if not line:
                continue
            if line[0] in ' \t' and raw:
                raw[-1][1] += ' ' + line.strip()
                continue
            if ':' not in line:
                continue
            name, value = line.split(':', 1)
            name = name.strip().lower()
            raw.append([_COMPACT.get(name, name), value.strip()])
        for name, value in raw:
            if name in _SPLIT:
                for part in split_commas(value):
                    msg.headers.append([name, part])
            else:
                msg.headers.append([name, value])
        cl = msg.get('content-length')
        if cl and cl.strip().isdigit():
            body = body[:int(cl)]
        msg.body = body
        return msg

    # -- header access ----------------------------------------------------
    @property
    def is_request(self):
        return self.method is not None

    def get(self, name, default=None):
        name = name.lower()
        for n, v in self.headers:
            if n == name:
                return v
        return default

    def get_all(self, name):
        name = name.lower()
        return [v for n, v in self.headers if n == name]

    def add(self, name, value):
        self.headers.append([name.lower(), str(value)])

    def remove(self, name):
        name = name.lower()
        self.headers = [h for h in self.headers if h[0] != name]

    def set(self, name, value):
        name = name.lower()
        for i, h in enumerate(self.headers):
            if h[0] == name:
                h[1] = str(value)
                self.headers = self.headers[:i + 1] + [x for x in self.headers[i + 1:] if x[0] != name]
                return
        self.add(name, value)

    @property
    def call_id(self):
        return self.get('call-id', '')

    @property
    def cseq(self):
        val = self.get('cseq', '0 NONE').split()
        try:
            return int(val[0]), (val[1].upper() if len(val) > 1 else '')
        except ValueError:
            return 0, ''

    def copy(self):
        return SipMessage.parse(self.serialize())

    def first_line(self):
        if self.is_request:
            return f'{self.method} {self.uri} SIP/2.0'
        return f'SIP/2.0 {self.status} {self.reason}'

    def serialize(self):
        lines = [self.first_line()]
        for n, v in self.headers:
            if n != 'content-length':
                lines.append(f'{canon(n)}: {v}')
        lines.append(f'Content-Length: {len(self.body)}')
        return ('\r\n'.join(lines) + '\r\n\r\n').encode('utf-8') + self.body


# -- helpers ---------------------------------------------------------------

def parse_params(s):
    out = {}
    for p in s.split(';'):
        p = p.strip()
        if not p:
            continue
        k, _, v = p.partition('=')
        out[k.strip().lower()] = v.strip()
    return out


_NA_RE = re.compile(r'^\s*(?:"((?:[^"\\]|\\.)*)"|([^<"]*?))\s*<([^>]*)>(.*)$')


def parse_name_addr(value):
    """Returns (display_name, uri, params)."""
    value = value or ''
    m = _NA_RE.match(value)
    if m:
        disp = (m.group(1) if m.group(1) is not None else m.group(2) or '').strip()
        return disp, m.group(3).strip(), parse_params(m.group(4))
    parts = value.split(';', 1)
    return '', parts[0].strip(), parse_params(parts[1] if len(parts) > 1 else '')


def get_tag(value):
    return parse_name_addr(value)[2].get('tag') or None


def parse_uri(uri):
    """Returns (scheme, user, host, port, params)."""
    u = (uri or '').strip()
    scheme = 'sip'
    head, sep, rest = u.partition(':')
    if sep and head.lower() in ('sip', 'sips', 'tel'):
        scheme, u = head.lower(), rest
    u = u.split('?', 1)[0]
    parts = u.split(';')
    hostpart = parts[0]
    params = parse_params(';'.join(parts[1:]))
    user = ''
    if '@' in hostpart:
        user, hostpart = hostpart.rsplit('@', 1)
        user = user.split(':', 1)[0]
    host, port = hostpart, None
    if hostpart.startswith('['):
        end = hostpart.find(']')
        host = hostpart[1:end]
        rest = hostpart[end + 1:]
        if rest.startswith(':') and rest[1:].isdigit():
            port = int(rest[1:])
    elif ':' in hostpart:
        host, p = hostpart.rsplit(':', 1)
        if p.isdigit():
            port = int(p)
    return scheme, user, host, port, params


def parse_via(value):
    """Returns (host, port, params) for a single Via value."""
    _, _, rest = (value or '').strip().partition(' ')
    parts = rest.strip().split(';')
    sent_by = parts[0].strip()
    params = parse_params(';'.join(parts[1:]))
    host, port = sent_by, None
    if ':' in sent_by and not sent_by.startswith('['):
        host, p = sent_by.rsplit(':', 1)
        port = int(p) if p.isdigit() else None
    return host, port, params


def gen_branch():
    return 'z9hG4bK' + os.urandom(8).hex()


def gen_tag():
    return os.urandom(5).hex()


def gen_call_id(host):
    return f'{os.urandom(10).hex()}@{host}'


_AUTH_RE = re.compile(r'(\w+)\s*=\s*(?:"([^"]*)"|([^\s,]+))')


def parse_auth(value):
    _, _, rest = (value or '').strip().partition(' ')
    out = {}
    for m in _AUTH_RE.finditer(rest):
        out[m.group(1).lower()] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


def build_auth(method, uri, username, password, chal, nc=1):
    def md5(s):
        return hashlib.md5(s.encode('utf-8')).hexdigest()

    realm = chal.get('realm', '')
    nonce = chal.get('nonce', '')
    algo = chal.get('algorithm', 'MD5')
    qop = chal.get('qop')
    cnonce = os.urandom(8).hex()
    ha1 = md5(f'{username}:{realm}:{password}')
    if algo.upper() == 'MD5-SESS':
        ha1 = md5(f'{ha1}:{nonce}:{cnonce}')
    ha2 = md5(f'{method}:{uri}')
    parts = [f'username="{username}"', f'realm="{realm}"', f'nonce="{nonce}"', f'uri="{uri}"']
    if qop:
        options = [q.strip() for q in qop.split(',')]
        qop_val = 'auth' if 'auth' in options else options[0]
        nc_s = f'{nc:08x}'
        resp = md5(f'{ha1}:{nonce}:{nc_s}:{cnonce}:{qop_val}:{ha2}')
        parts += [f'response="{resp}"', f'qop={qop_val}', f'nc={nc_s}', f'cnonce="{cnonce}"']
    else:
        parts.append(f'response="{md5(f"{ha1}:{nonce}:{ha2}")}"')
    parts.append(f'algorithm={algo}')
    if 'opaque' in chal:
        parts.append(f'opaque="{chal["opaque"]}"')
    return 'Digest ' + ', '.join(parts)


def random_session_id():
    return random.randint(10 ** 8, 10 ** 9)
