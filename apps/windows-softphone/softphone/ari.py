"""Asterisk ARI client used to list registered (online) extensions.

GET {base}/ari/endpoints returns e.g.
    [{"technology": "PJSIP", "resource": "1001", "state": "online", "channel_ids": []}, ...]
"""
import base64
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit

SIP_TECHS = ('PJSIP', 'SIP')


class AriError(Exception):
    pass


def default_url(sip_server):
    host = (sip_server or '').strip()
    if host.lower().startswith('sip:'):
        host = host[4:]
    host = host.split(';')[0].split(':')[0]
    return f'http://{host}:8088' if host else ''


def normalize_url(url):
    url = (url or '').strip().rstrip('/')
    if url and '://' not in url:
        url = 'http://' + url
    if url.endswith('/ari'):
        url = url[:-4]
    return url


class AriClient:
    def __init__(self, url, username, password, timeout=5):
        self.base = normalize_url(url)
        if not self.base or not urlsplit(self.base).hostname:
            raise AriError('Directory server URL is not set')
        token = base64.b64encode(f'{username}:{password}'.encode('utf-8')).decode()
        self.headers = {'Authorization': f'Basic {token}', 'Accept': 'application/json'}
        self.timeout = timeout

    def _get(self, path):
        req = urllib.request.Request(self.base + path, headers=self.headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise AriError('ARI login failed (401) – check user/password in ari.conf') from None
            raise AriError(f'ARI HTTP {e.code} {e.reason}') from None
        except urllib.error.URLError as e:
            raise AriError(f'Cannot reach ARI at {self.base}: {e.reason}{self._hint()}') from None
        except (OSError, ValueError) as e:
            raise AriError(f'ARI error: {e}{self._hint()}') from None

    def _hint(self):
        if urlsplit(self.base).port == 8088:
            return ' – port 8088 is usually closed to the internet; use the https:// address instead'
        return ''

    def endpoints(self):
        """Returns a list of dicts: ext, tech, state, in_call."""
        data = self._get('/ari/endpoints')
        if not isinstance(data, list):
            raise AriError('Unexpected ARI response')
        out = []
        for ep in data:
            tech = str(ep.get('technology', '')).upper()
            if tech not in SIP_TECHS:
                continue
            out.append({
                'ext': str(ep.get('resource', '')),
                'tech': tech,
                'state': str(ep.get('state', 'unknown')).lower(),
                'in_call': bool(ep.get('channel_ids')),
            })
        return out
