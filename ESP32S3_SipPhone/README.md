# ESP32-S3 SIP phone

Registers to a SIP server (tested target: Asterisk on the same LAN) and answers incoming calls with two-way G.711 audio through the INMP441 microphone and MAX98357A speaker. All Wi-Fi, SIP and audio settings are set over **Bluetooth LE** from the Flutter app (`sipphone_setup_app`) or a browser page and stored in flash. Bluetooth is always on, so settings can be changed at any time. Arduino-ESP32 **3.3.12**, no external libraries, no PSRAM required.

Wiring is identical to `ESP32S3_AudioWebTest` (GPIO4 BCLK, GPIO5 WS, GPIO6 mic SD, GPIO7 amp DIN). Verify the mic and speaker with that bench sketch first.

## Build and flash

From the repository root:

```powershell
$env:AUDIO_SKETCH='ESP32S3_SipPhone'
.\build.bat COM5
```

`build.bat` selects the **Minimal SPIFFS (1.9 MB APP with OTA)** partition scheme for this sketch, because Wi-Fi plus Bluetooth needs more than the default 1.2 MB app slot leaves spare. In the Arduino IDE choose Tools > Partition Scheme > *Minimal SPIFFS*. Any module with at least 4 MB flash works.

## Set it up over Bluetooth

1. Power the phone. It always advertises over Bluetooth, and the Serial Monitor shows `[BLE] advertising as "SipPhone-XXXX"`.
2. Open [`provision.html`](provision.html) in **Chrome or Edge** on Android, Windows, macOS or Linux. Double-click the file, or serve the folder with `python -m http.server` and open `http://localhost:8000/provision.html`. On iPhone use the Bluefy browser.
3. Click **Connect**, pick `SipPhone-XXXX`, and accept the pairing prompt if your system shows one.
4. Fill in Wi-Fi, SIP server, extension and password, then click **Save and restart**.
5. The phone validates and stores the settings and restarts; the page or app reconnects when it is back. Check that the status shows Wi-Fi *connected* and SIP *registered*.

| Setting | Meaning |
| --- | --- |
| Wi-Fi SSID / password | 2.4 GHz network; tick *Open network* for none |
| SIP server, port | Asterisk address, usually port 5060 |
| Extension / user, password | Must match the Asterisk endpoint (e.g. 1001) |
| Auth user, domain | Only if your server needs them to differ from user / server |
| Auto-answer delay | ms after ringing starts; -1 = answer with the button only |
| Speaker volume, mic gain | 0-100 %, 1-32 |
| Registration expiry, local SIP/RTP ports | Advanced; defaults 300 s, 5060, 4000 |

Password fields left empty keep the saved password. The device never sends passwords back. **Factory reset** on the page, or `X` on Serial, erases all saved settings.

### Bluetooth details

The service is `6b3f0001-7c1a-4d2e-9b8f-2a1c5e7d9f01`:

| Characteristic | UUID suffix | Access | Content |
| --- | --- | --- | --- |
| Config | `…0002` | read / write, encrypted | Settings JSON, keys as in the table above (`wifi_ssid`, `sip_password`, …) |
| Command | `…0003` | write, encrypted | `begin`, `save`, `reboot`, `factory_reset` |
| Status | `…0004` | read / notify | Wi-Fi, IP, SIP registration, call state, last result |

To write settings with a generic BLE app such as nRF Connect: write `begin` to Command, then write the JSON to Config in one or more chunks (they are appended), then write `save`. Keys you leave out keep their current values. Pairing is "Just Works" with LE Secure Connections, so the link is encrypted but there is no PIN. Because Bluetooth is always on, **anyone within Bluetooth range can connect and change the settings** (they can't read the saved passwords). Use this only where that's acceptable.

### Defaults in firmware (optional)

`config.example.h` supplies first-boot defaults and the pin numbers. To bake an account into the firmware, copy it to `config.h` (git-ignored) and fill it in. Settings saved over Bluetooth always take precedence.

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
| BOOT press | Answer when ringing, otherwise hang up |
| `a` / `h` | Answer / hang up or decline |
| `s` | Status: registration, call state, RTP counters, mic peak, Bluetooth |
| `r` | Re-register now |
| `+` / `-` | Speaker volume ±10% (saved) |
| `]` / `[` | Mic gain ±1 (saved) |
| `X` | Factory reset |

## How it works

- `settings.cpp`: settings in NVS (`Preferences`, namespace `sipphone`), validation, and the JSON used over Bluetooth.
- `ble_prov.cpp`: the setup-mode GATT service (NimBLE). Writes arrive in the BLE task and are applied by the main loop.
- `sip.cpp`: a small SIP UA over UDP. It handles REGISTER with MD5 digest auth and refreshes it before expiry, then INVITE → 100/180/200, ACK, CANCEL (487), BYE, re-INVITE (hold, media change), OPTIONS and NOTIFY. One call at a time; a second INVITE gets 486 Busy.
- `audio.cpp`: one full-duplex I2S port at 16 kHz/32-bit, in a FreeRTOS task on core 1. The mic path applies a DC blocker and gain, then halfband decimation to 8 kHz and G.711 (PCMU/PCMA), sent as 20 ms RTP packets. The receive path runs through a 60 ms jitter buffer, G.711 decode, interpolation to 16 kHz and volume control before reaching the speaker.

## Limitations

- UDP only, no NAT/STUN: the ESP32 and the SIP server must reach each other directly (same LAN).
- No TLS/SRTP, DTMF, outgoing calls, or echo cancellation. Keep the speaker volume low.
- Pin numbers are build-time only (`config.h`), not settable over Bluetooth.
- Bluetooth shares the 2.4 GHz radio with Wi-Fi and stays on during calls. It advertises only every 0.5-1 s to leave airtime for RTP, but avoid keeping the app connected during a call.

## Troubleshooting

- **Page shows "no Web Bluetooth"**: use Chrome or Edge. Firefox and Safari don't support it.
- **Phone not in the device list**: check Serial for `[BLE] advertising`, move closer, and make sure no other device is still connected to it.
- **Pairing fails after a factory reset or reflash**: remove `SipPhone-XXXX` from your computer or phone's Bluetooth devices and connect again.
- **`registration failed: no response`**: wrong SIP server or port, or a firewall on the server.
- **`401 Unauthorized` repeatedly**: wrong SIP password or auth user.
- **Connected but silent one way**: run `s` during the call. `rx=0` means no RTP is arriving (set `direct_media=no` and `rtp_symmetric=yes`, check the firewall on the RTP port).
- **Choppy audio**: check `underruns` and `lost` and the Wi-Fi RSSI; disconnect the setup app or page.
