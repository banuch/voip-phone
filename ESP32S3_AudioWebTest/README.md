# ESP32-S3 microphone and speaker web test

Arduino sketch for INMP441 capture and MAX98357A playback, controlled from a browser on the same Wi-Fi. Uses only libraries bundled with **Espressif Arduino-ESP32 3.3.12**. PSRAM is required and must be enabled. No SD card, cloud service, or additional library is required. This is an audio hardware test; SIP is not included.

## Wiring

| ESP32-S3 | Connection |
| --- | --- |
| GPIO4 | INMP441 SCK and MAX98357A BCLK |
| GPIO5 | INMP441 WS and MAX98357A LRC/WS |
| GPIO6 | INMP441 SD |
| GPIO7 | MAX98357A DIN |
| 3V3 | INMP441 VDD |
| GND | INMP441 GND and L/R, amplifier GND, supply GND |
| Regulated 5 V | MAX98357A VIN |

Speaker connects across SPK+ and SPK-. Neither speaker lead connects to GND. Configure amplifier SD/EN and GAIN according to your breakout's schematic. The sketch does not drive an enable pin. Verify the GPIO header labels against your actual board.

Keep microphone 3.3 V and amplifier 5 V separate. The earlier illustration has incorrect rail/ground connections; follow this table and `ESP32_CIRCUIT_NOTES.md`. Avoid backfeeding USB through an external board supply. Use a suitable amplifier supply with local decoupling and common ground.

## Arduino IDE setup

1. Install/select **esp32 by Espressif Systems 3.3.12** in Boards Manager.
2. Open `ESP32S3_AudioWebTest.ino` from its matching folder.
3. Select your exact ESP32-S3 board; use **ESP32S3 Dev Module** for a generic development board. Set Flash Size to the actual hardware size. Enable PSRAM with the correct type for your module: Tools > PSRAM > OPI PSRAM or QSPI PSRAM. For example, WROOM-1 N8R8 uses OPI and N8R2 uses QSPI. Check the printed module code instead of guessing. See the official troubleshooting table linked below.
4. Choose a partition scheme with at least **1 MB filesystem space** and enough application space for the sketch. A 4 MB layout with approximately 1.2 MB application slots and 1.5 MB SPIFFS space is suitable. Arduino's partition menu may label this region SPIFFS; LittleFS uses that filesystem partition. Do not select a no-filesystem layout.
5. Set `WIFI_SSID` and `WIFI_PASSWORD` near the top of the sketch. Use a 2.4 GHz Wi-Fi network.
6. Select the USB port and upload. If using native USB serial, enable USB CDC On Boot as needed for your board; USB-to-UART boards use their UART serial port.
7. Open Serial Monitor at **115200 baud**, reset if necessary, and wait for `Open http://192.168...`.
8. Open the printed HTTP address on a phone or computer connected to the same LAN. Guest network/client isolation can prevent access.

On first use, LittleFS is formatted if it cannot mount. This can erase pre-existing files in the selected filesystem partition. The sketch itself needs no separate filesystem upload.

## Tests

1. Start with the volume at 25%. Choose and upload the included `test-tone-16k-mono.wav` (two seconds of quiet 440 Hz tone), then click **Play uploaded file**. Sound comes from the ESP32 speaker. You can then try your own compatible WAV.
2. Choose a recording duration from 1 to 10 seconds and click **Record microphone**. Speak near the INMP441; the peak indicator should respond. Recording automatically stops at the chosen sample count, or you can use **Stop**.
3. Click **Play recording** to hear it on the ESP32 speaker. Click **Download recording** to save the WAV and listen on your computer.
4. Repeat with different speaker volumes. Adjust `MIC_GAIN` in the sketch if recordings are too quiet or clipped; default gain is 4. There is no automatic gain control.

Uploaded audio must be **RIFF/WAVE, PCM format 1, mono, 16 kHz, 16 bits, at most 10 seconds**. MP3, floating-point WAV, stereo WAV and extensible WAV are rejected. Non-audio WAV metadata is allowed within a 4096-byte overhead budget.

Optional FFmpeg conversion on a computer that already has FFmpeg:

```sh
ffmpeg -i input.mp3 -t 10 -ar 16000 -ac 1 -c:a pcm_s16le output.wav
```

The latest uploaded WAV and microphone recording are stored as separate flash files, retained across reboot. A successfully saved recording replaces the previous recording; a new validated upload replaces the previous upload. Recorded audio is up to 320,044 bytes. At least 1 MB filesystem space accommodates both audio files and an incoming replacement upload. Frequent recording writes wear flash, so this is intended for bench testing.

## How audio works

The ESP32 supplies shared BCLK and WS. One 320,000-byte buffer is explicitly allocated in external PSRAM using MALLOC_CAP_SPIRAM. It is reused because recording and playback are exclusive. Capture uses 32-bit stereo I2S slots, reads the microphone's left slot, applies fixed gain with saturation, and appends mono 16-bit PCM to this buffer. When recording stops, I2S is shut down and the PCM is saved as a WAV through a temporary flash file. Playback loads the entire validated WAV PCM payload into PSRAM before starting I2S. There are no flash file reads or writes in the active audio chunk path. Small I2S transfer buffers remain in internal RAM; PSRAM is not passed directly to DMA. Playback expands WAV samples into 32-bit slots and duplicates them into both left and right channels so the amplifier's channel selection does not discard the signal. Recording and playback use separate I2S sessions. The speaker is silent during recording; this does not test simultaneous two-way audio or echo cancellation.

HTTP requests and audio chunks are serviced in the main loop. Uploading and downloading files are synchronous. The interface is for one operator at a time; keep it on your trusted LAN. The page polls status approximately every 700 ms. Playback drains its DMA tail before stopping, which can briefly delay a status response.

## Troubleshooting

- **PSRAM unavailable:** choose the correct OPI/QSPI setting for the actual module and reboot. Serial Monitor reports detected PSRAM size and allocated audio buffer bytes; the page reports both too. Audio controls are disabled if detection or allocation fails. The sketch deliberately does not fall back to internal RAM.
- **No serial IP:** confirm Wi-Fi credentials, 2.4 GHz network and USB serial settings. The sketch keeps trying to connect; it does not create a fallback hotspot.
- **Filesystem error / insufficient space:** select a larger filesystem partition and verify physical flash size. Partition changes can require erasing/reformatting existing flash contents.
- **Silent speaker:** check amplifier VIN, GND, SD/EN, speaker terminals, GPIO7, BCLK/WS and volume. Verify amplifier breakout enable behavior.
- **Silent recording:** check microphone 3.3 V, ground, L/R to ground, and SD to GPIO6. Do not connect SD to ground.
- **Clipped recording:** reduce `MIC_GAIN`; a peak repeatedly near 32768 indicates saturation.
- **Reset or distortion during playback:** check amplifier power, grounding and decoupling, and reduce volume.

## Validation and reference

Compile target: `esp32:esp32:esp32s3:PSRAM=opi` with Arduino-ESP32 3.3.12. This checks compilation with PSRAM enabled; select OPI or QSPI for your actual module when uploading. Hardware behavior and detected PSRAM must be verified on the actual board and breakouts.

[Espressif I2S API documentation](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2s.html)

[Espressif module PSRAM settings table](https://docs.espressif.com/projects/arduino-esp32/en/latest/troubleshooting.html)
