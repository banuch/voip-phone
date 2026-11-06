# ESP32-S3 SIP phone

Registers to a SIP server (tested target: Asterisk on the same LAN) and answers incoming calls with two-way G.711 audio through the INMP441 microphone and MAX98357A speaker. Arduino-ESP32 **3.3.12**, no external libraries, no PSRAM required.

Wiring is identical to `ESP32S3_AudioWebTest` (GPIO4 BCLK, GPIO5 WS, GPIO6 mic SD, GPIO7 amp DIN). Verify the mic and speaker with that bench sketch first.

## Setup

1. Copy `config.example.h` to `config.h` in this folder and fill in Wi-Fi, SIP server address, extension and password. `config.h` is git-ignored. Without it the sketch compiles with placeholders and a warning.
2. Build and flash from the repository root:

   ```powershell
   $env:AUDIO_SKETCH='ESP32S3_SipPhone'
   .\build.bat COM5
   ```

3. In the Serial Monitor (115200) expect `[WIFI] connected`, then `[SIP] registered as 1001@...`.
4. Call extension 1001 from the operator softphone (1002). The ESP32 plays a ring tone, auto-answers after `AUTO_ANSWER_MS`, and prints `[CALL] connected`.

## Asterisk (PJSIP) endpoint example

```ini
[1001]
type=endpoint
context=internal
disallow=all
allow=ulaw,alaw
auth=1001
aors=1001
direct_media=no
rtp_symmetric=yes
force_rport=yes

[1001]
type=auth
auth_type=userpass
username=1001
password=change-me

[1001]
type=aor
max_contacts=1
qualify_frequency=30
```

## Controls

| Input | Action |
| --- | --- |
| BOOT button (GPIO0) | Answer when ringing, otherwise hang up |
| `a` / `h` | Answer / hang up or decline |
| `s` | Status: registration, call state, RTP counters, mic peak |
| `r` | Re-register now |
| `+` / `-` | Speaker volume ±10% |
| `]` / `[` | Mic gain ±1 |

Set `AUTO_ANSWER_MS` to `-1` to disable auto-answer.

## How it works

- `sip.cpp`: a small SIP UA over UDP. It handles REGISTER with MD5 digest auth and refreshes it before expiry, then INVITE → 100/180/200, ACK, CANCEL (487), BYE, re-INVITE (hold, media change), OPTIONS and NOTIFY. One call at a time; a second INVITE gets 486 Busy.
- `audio.cpp`: one full-duplex I2S port at 16 kHz/32-bit, in a FreeRTOS task on core 1. The mic path applies a DC blocker and gain, then halfband decimation to 8 kHz and G.711 (PCMU/PCMA, whichever the caller offers first), sent as 20 ms RTP packets. The receive path runs through a 60 ms jitter buffer, G.711 decode, interpolation to 16 kHz and volume control before reaching the speaker.

## Limitations

- UDP only, no NAT/STUN: the ESP32 and the SIP server must reach each other directly (same LAN).
- No TLS/SRTP, DTMF, outgoing calls, or echo cancellation. The speaker leaks into the mic, so keep `SPEAKER_VOLUME` low and the parts acoustically apart.

## Troubleshooting

- **`registration failed: no response`**: wrong `SIP_SERVER`/port, or a firewall on the server.
- **`401 Unauthorized` repeatedly**: wrong password or auth username.
- **Connected but silent one way**: run `s` during the call. `rx=0` means no RTP is arriving (set `direct_media=no` and `rtp_symmetric=yes`, check the firewall on UDP 4000). `tx` rising but the far end hears nothing usually means a codec mismatch or low mic gain.
- **Choppy audio**: check `underruns` and `lost` and the Wi-Fi RSSI. Wi-Fi power save is disabled in the sketch.
