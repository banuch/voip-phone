# Wintek Softphone

A compact MicroSIP-style SIP softphone for Windows that can also **play voice files into a live call**.

## Features

- **SIP account**: registration with digest auth (MD5, qop=auth), optional outbound proxy, NAT handling (rport/received, symmetric RTP, keep-alives)
- **Calls**: dial pad, call, answer, reject, hang up (with CANCEL), mute, hold/resume (re-INVITE), blind transfer (REFER)
- **Direct IP calls** with no account, e.g. `192.168.1.20` or `1001@192.168.1.20:5060`
- **Codecs**: G.711 PCMU / PCMA
- **DTMF**: RFC 4733 (RTP events), falling back to SIP INFO. Keypad and keyboard digits are sent during a call.
- **Voice files**
  - Add WAV, MP3, FLAC, OGG and Asterisk prompts (`.ulaw`, `.alaw`, `.sln`, `.raw`). Files are resampled to 8 kHz mono automatically.
  - **Play into call**: the remote party hears the file. Playback can be mixed with your mic or replace it ("mute my microphone while playing").
  - Loop, file volume (0–200 %), hear playback locally, and preview through the speakers
  - Automation: auto-answer after N seconds, auto-play a file when a call connects, and hang up when playback finishes. Together these make a simple announcement / IVR line.
- Contacts, call history (in / out / missed), custom ringtone, audio device selection and a SIP log window
- Settings are stored in `%APPDATA%\WintekSoftphone\config.json`. The password is encrypted with Windows DPAPI.

## Run from source

Requires Python 3.10+ on Windows.

```bat
pip install -r requirements.txt
python main.py
```

Or double-click `run.bat`.

## Build a standalone .exe

```bat
build_exe.bat
```

This produces `dist\WintekSoftphone.exe`, a single file with no Python needed on the target PC.

## Usage

1. **Phone ▸ Account…**: enter the SIP server (e.g. `pbx.example.com` or `192.168.1.10`), username/extension and password.
   The dot at the top turns green when you are registered.
2. Type a number and press **Call** (or Enter). Esc hangs up.
3. **Voice files** tab: click **Add…** to add prompts. During a call, select a file and press **▶ Play in call**
   (or use the quick player on the Phone tab).

Allow the app through Windows Firewall when asked; it needs UDP 5060 for SIP and 10000–20000 for RTP.

## Tests

```bat
python tests\loopback_test.py
```

The test runs two phones on localhost and checks call setup, two-way RTP, voice-file mixing, DTMF, hold and BYE.

## Layout

| File | Purpose |
|------|---------|
| `softphone/sip_ua.py` | SIP user agent: transactions, registration, calls, hold, transfer |
| `softphone/sip_message.py` | SIP parser/serializer, digest auth |
| `softphone/sdp.py` | SDP offer/answer |
| `softphone/rtp.py` | RTP send/receive, RFC 4733 DTMF |
| `softphone/g711.py` | PCMU/PCMA codec |
| `softphone/audio.py` | Sound card I/O, mixer, file player, tones |
| `softphone/filedecode.py` | Voice-file decoding to 8 kHz |
| `softphone/ui.py` | Tkinter UI |

## Limitations

UDP transport only (no TCP/TLS/SRTP), G.711 only, and one call at a time: a second incoming call gets 486 Busy.
