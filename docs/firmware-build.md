# Windows build script

`firmware/build.bat` is adapted from the AMR firmware build script. Run it from PowerShell:

```powershell
.\firmware\build.bat compile       # Compile only; no board needed
.\firmware\build.bat COM5 upload   # Compile and upload
.\firmware\build.bat COM5 monitor  # Serial monitor only
.\firmware\build.bat COM5          # Compile, upload and monitor
.\firmware\build.bat               # Same, with unambiguous port auto-detection
```

Install Arduino CLI and `esp32:esp32` 3.3.12 first. Enter Wi-Fi credentials in the sketch before uploading. The script finds the sketch relative to itself and works when launched from another folder. Build intermediates go to `firmware/.build/<sketch>-batch`; firmware images go to `firmware/release`. It does not depend on AMR's `config.h`, firmware version, sketch name or OTA dashboard.

Defaults retain the AMR script's ESP32-S3 native USB CDC, QIO flash, 16 MB flash and OPI PSRAM settings. The partition scheme is changed to `default` to provide the SPIFFS-labelled data partition used by this sketch's LittleFS, instead of AMR's FAT layout. Confirm flash size and PSRAM type against your module before uploading. The default partition uses only the first 4 MB of flash, with approximately 1.2 MB application slots and 1.5 MB filesystem space, sufficient for this test.

Override board options for a different module:

```powershell
$env:AUDIO_FQBN = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashMode=qio,FlashSize=8M,PartitionScheme=default,PSRAM=opi'
.\firmware\build.bat compile
```

Use `PSRAM=qspi` for a module requiring QSPI. See the sketch README for wiring and browser setup. If USB re-enumerates to a new COM number after upload, run the monitor command with that new port. The monitor's exit status is preserved as failure when it cannot start. For scripted use set `$env:NOPAUSE='1'` to skip pauses on errors.
