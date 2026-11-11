"""Persistent settings stored in %APPDATA%\\WintekSoftphone\\config.json.

The SIP password is encrypted with Windows DPAPI (bound to the current user).
"""
import base64
import copy
import ctypes
import json
import os
import sys

CONFIG_DIR = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'WintekSoftphone')
CONFIG_PATH = os.path.join(CONFIG_DIR, 'config.json')

DEFAULTS = {
    'account': {
        'display_name': '', 'domain': '', 'proxy': '', 'username': '', 'auth_user': '',
        'password': '', 'expires': 300, 'register': True, 'nat': True, 'local_port': 5060,
    },
    'codecs': ['PCMU', 'PCMA'],
    'audio': {'input': '', 'output': '', 'ringtone': '', 'mic_gain': 100, 'spk_gain': 100},
    'voice': {
        'files': [], 'loop': False, 'mute_mic': True, 'monitor': True, 'gain': 100,
        'autoplay': False, 'autoplay_file': '', 'hangup_after': False,
    },
    'auto_answer': False,
    'auto_answer_delay': 2,
    'contacts': [],
    'history': [],
    'geometry': '',
}


# -- DPAPI -----------------------------------------------------------------------
class _Blob(ctypes.Structure):
    _fields_ = [('cbData', ctypes.c_uint32), ('pbData', ctypes.POINTER(ctypes.c_char))]


def _dpapi(data, protect):
    if sys.platform != 'win32':
        return data
    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(blob_in), None, None, None, None, 0x1, ctypes.byref(blob_out)):
        raise OSError('DPAPI call failed')
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _encrypt(text):
    if not text:
        return ''
    return base64.b64encode(_dpapi(text.encode('utf-8'), True)).decode()


def _decrypt(token):
    if not token:
        return ''
    try:
        return _dpapi(base64.b64decode(token), False).decode('utf-8')
    except Exception:
        return ''


# -- load / save ----------------------------------------------------------------
def _merge(defaults, data):
    out = copy.deepcopy(defaults)
    for k, v in (data or {}).items():
        if isinstance(out.get(k), dict) and isinstance(v, dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load():
    data = {}
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        pass
    cfg = _merge(DEFAULTS, data)
    acc = cfg['account']
    acc['password'] = _decrypt(acc.pop('password_enc', '')) or acc.get('password', '')
    return cfg


def save(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    out = copy.deepcopy(cfg)
    acc = out['account']
    password = acc.pop('password', '')
    try:
        acc['password_enc'] = _encrypt(password)
    except OSError:
        acc['password'] = password
    tmp = CONFIG_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
    os.replace(tmp, CONFIG_PATH)
