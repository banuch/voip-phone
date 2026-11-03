# ESP32-S3 SIP intercom circuit reference

Extracted on 2026-11-03 from the chat [ESP32 SIP Audio Design](https://chatgpt.com/c/6ae94237-1944-83ec-ba32-9c7c3d3eef95) and its attached circuit image. This records the intended prototype, not verification of the purchased hardware. No sample code has been started.

## Intended hardware

- ESP32-S3 development board; exact board model and memory configuration unknown.
- INMP441 I2S microphone breakout.
- MAX98357A I2S amplifier breakout.
- Speaker labelled 4 ohm, 3 W in the source image.
- Regulated 5 V power source; source image specifies at least 1 A, actual current budget remains to be checked.

## Intended connections

| ESP32-S3 / supply | Module pin | Purpose |
| --- | --- | --- |
| 3V3 | INMP441 VDD | Microphone supply |
| GND | INMP441 GND | Common ground |
| GPIO4 | INMP441 SCK and MAX98357A BCLK | Shared I2S bit clock |
| GPIO5 | INMP441 WS and MAX98357A LRC/WS | Shared I2S word clock |
| GPIO6 | INMP441 SD | Audio input to ESP32 |
| GND | INMP441 L/R | Intended left-channel selection |
| GPIO7 | MAX98357A DIN | Audio output from ESP32 |
| Regulated 5 V | MAX98357A VIN | Amplifier supply |
| GND | MAX98357A GND | Common ground |
| MAX98357A SPK+ / SPK- | Speaker terminals | Differential speaker output; neither terminal goes to ground |

MAX98357A SD/EN and GAIN configuration must be determined from the exact breakout schematic. Do not copy their pictured wiring as an established configuration.

## Errors and ambiguities visible in the source image

1. The red USB 5 V line has a junction with the red vertical wire feeding microphone VDD / ESP32 3V3. This would join the 5 V and 3.3 V rails if copied literally. Keep these rails separate; microphone VDD belongs on 3V3.
2. The microphone GND trace meets the SD/GPIO6 trace instead of clearly reaching common ground. Wire microphone GND directly to common GND and keep SD separate.
3. Amplifier BCLK and WS are drawn to different ESP32 header positions from the labelled microphone GPIO4 and GPIO5 wires. The table expresses the intended shared nets: physically join both BCLK inputs to GPIO4 and both WS inputs to GPIO5. Do not infer GPIO numbers from the illustration's header positions.
4. The bottom black wire appears to reach amplifier GAIN as well as GND. This conflicts with the note claiming default gain. Check the exact module before deciding GAIN wiring.
5. Amplifier SD/EN is unconnected in the drawing. Its enable and channel-selection behavior depends on the module circuitry and needs checking.
6. Exact ESP32 header pins, USB/external power isolation, and amplifier supply decoupling are unverified. The image is illustrative, not a reliable board pinout.

## Audio and system intent

Microphone -> ESP32 I2S receive -> voice processing / codec -> Wi-Fi RTP -> Asterisk -> operator SIP client.

Operator SIP client -> Asterisk -> Wi-Fi RTP -> ESP32 codec / PCM -> I2S transmit -> MAX98357A -> speaker.

ESP32 is intended to provide BCLK and WS, with separate receive (GPIO6) and transmit (GPIO7) data. The earlier chat proposes 32-bit I2S slots for microphone capture and G.711 A-law or mu-law at 8 kHz for SIP; final driver configuration and sample conversion remain to be designed and verified against datasheets. Shared RX/TX clocks require compatible slot and sample-rate configuration.

The proposed SIP identity is extension 1001, replacing the laptop simulator; the operator is extension 1002. Incoming calls are intended to auto-answer for two-way voice. Hands-free echo control remains a separate firmware requirement; the modules do not establish that it is solved.

## Later implementation sequence

1. Identify exact board and breakout variants; confirm power and pin labels.
2. Test microphone capture and levels.
3. Test speaker playback at low volume.
4. Test simultaneous I2S receive/transmit.
5. Add Wi-Fi, SIP registration, call handling and RTP audio.
6. Evaluate acoustic echo and hands-free behavior.

Before choosing sample-code APIs, establish ESP-IDF versus Arduino, installed version, board model and available flash/PSRAM. No framework or SIP library has been selected yet.
