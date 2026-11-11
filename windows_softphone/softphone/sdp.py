"""Minimal SDP offer/answer for G.711 audio + RFC 4733 DTMF."""

CODEC_NAMES = {0: 'PCMU', 8: 'PCMA'}
CODEC_PTS = {'PCMU': 0, 'PCMA': 8}


def build_sdp(ip, port, codecs, dtmf_pt=101, direction='sendrecv', sess_id=1, version=1):
    pts = list(codecs) + ([dtmf_pt] if dtmf_pt is not None else [])
    lines = [
        'v=0',
        f'o=- {sess_id} {version} IN IP4 {ip}',
        's=Wintek Softphone',
        f'c=IN IP4 {ip}',
        't=0 0',
        f'm=audio {port} RTP/AVP {" ".join(str(p) for p in pts)}',
    ]
    for pt in codecs:
        lines.append(f'a=rtpmap:{pt} {CODEC_NAMES[pt]}/8000')
    if dtmf_pt is not None:
        lines.append(f'a=rtpmap:{dtmf_pt} telephone-event/8000')
        lines.append(f'a=fmtp:{dtmf_pt} 0-16')
    lines.append('a=ptime:20')
    lines.append(f'a={direction}')
    return ('\r\n'.join(lines) + '\r\n').encode()


def parse_sdp(body):
    res = {'ip': None, 'port': 0, 'payloads': [], 'rtpmap': {}, 'direction': 'sendrecv', 'dtmf_pt': None}
    if not body:
        return res
    session_ip = media_ip = None
    in_audio = None  # None = session level
    for line in body.decode('utf-8', 'replace').splitlines():
        line = line.strip()
        if line.startswith('c='):
            ip = line.split()[-1]
            if in_audio:
                media_ip = ip
            elif in_audio is None:
                session_ip = ip
        elif line.startswith('m='):
            in_audio = line.startswith('m=audio')
            if in_audio and not res['port']:
                parts = line[2:].split()
                res['port'] = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
                res['payloads'] = [int(p) for p in parts[3:] if p.isdigit()]
        elif line.startswith('a=') and in_audio is not False:
            attr = line[2:]
            if attr.startswith('rtpmap:'):
                pt, _, enc = attr[7:].partition(' ')
                if pt.isdigit():
                    res['rtpmap'][int(pt)] = enc.split('/')[0].upper()
            elif attr in ('sendrecv', 'sendonly', 'recvonly', 'inactive'):
                res['direction'] = attr
    for pt in res['payloads']:
        if pt in CODEC_NAMES and pt not in res['rtpmap']:
            res['rtpmap'][pt] = CODEC_NAMES[pt]
        if res['rtpmap'].get(pt) == 'TELEPHONE-EVENT' and res['dtmf_pt'] is None:
            res['dtmf_pt'] = pt
    res['ip'] = media_ip or session_ip
    return res


def choose_codec(remote, preferred):
    """Pick the first codec in the remote list that we support."""
    for pt in remote['payloads']:
        name = remote['rtpmap'].get(pt)
        if name in CODEC_PTS and CODEC_PTS[name] in preferred:
            return CODEC_PTS[name]
    return None
