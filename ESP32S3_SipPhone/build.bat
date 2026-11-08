@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Build, flash and monitor the ESP32-S3 SIP phone over the UART serial port:
rem the board's USB-to-serial chip (CH340 / CP210x / FTDI, connector usually
rem labelled "UART" or "COM"), not the native USB port of the ESP32-S3.
rem Serial output goes to UART0 (GPIO43 TX / GPIO44 RX), so USB CDC On Boot is off.
rem
rem Usage: build.bat [COM5] [compile^|upload^|monitor^|all]
rem        build.bat compile
rem Default mode: all (compile, upload, monitor). NOPAUSE=1 disables error pauses.
rem Override the board options with SIP_FQBN, e.g. for a 4 MB module without PSRAM:
rem   set SIP_FQBN=esp32:esp32:esp32s3:CDCOnBoot=default,UploadMode=default,FlashMode=qio,FlashSize=4M,PartitionScheme=min_spiffs,PSRAM=disabled
rem Override the upload speed with SIP_UPLOAD_SPEED (default 921600; try 460800
rem or 115200 if uploads fail on a long cable or a CH340).

set "SKETCH=%~dp0."
set "SKETCH_NAME=ESP32S3_SipPhone"
rem min_spiffs: two 1.9 MB app slots for firmware updates over Wi-Fi.
set "FQBN=esp32:esp32:esp32s3:CDCOnBoot=default,UploadMode=default,FlashMode=qio,FlashSize=16M,PartitionScheme=min_spiffs,PSRAM=opi"
if defined SIP_FQBN set "FQBN=%SIP_FQBN%"
set "UPLOAD_SPEED=921600"
if defined SIP_UPLOAD_SPEED set "UPLOAD_SPEED=%SIP_UPLOAD_SPEED%"
set "BAUD=115200"
set "BUILD=%~dp0..\.build\%SKETCH_NAME%-uart"
set "RELEASE=%~dp0..\release"
set "PORT=%~1"
set "MODE=%~2"
if not defined MODE (
  for %%M in (compile upload monitor all) do (
    if /i "!PORT!"=="%%M" (
      set "MODE=%%M"
      set "PORT="
    )
  )
)
if not defined MODE set "MODE=all"
set "VALID="
for %%M in (compile upload monitor all) do if /i "%MODE%"=="%%M" set "VALID=1"
if not defined VALID (
  echo [ERROR] Usage: build.bat [COM5] [compile^|upload^|monitor^|all]
  goto :fail
)
if not "%~3"=="" (
  echo [ERROR] Too many arguments.
  goto :fail
)
where arduino-cli >nul 2>&1
if errorlevel 1 (
  echo [ERROR] arduino-cli not found in PATH.
  goto :fail
)
if exist "%SKETCH%\partitions.csv" (
  echo [WARN] partitions.csv in the sketch folder overrides min_spiffs; check it keeps two OTA app slots.
)
if /i "%MODE%"=="monitor" goto :detect

echo.
echo [1/3] Compiling %SKETCH_NAME%
echo Board: %FQBN%
call arduino-cli compile --fqbn "%FQBN%" --build-path "%BUILD%" --output-dir "%RELEASE%" "%SKETCH%"
if errorlevel 1 (
  echo [ERROR] Compile failed.
  goto :fail
)
echo Firmware images: %RELEASE%
if /i "%MODE%"=="compile" goto :done

:detect
rem Auto-select the only serial port that is not the ESP32-S3's native USB.
rem arduino-cli names native USB ports after the board ("ESP32..."); a
rem USB-to-serial bridge shows up as a plain "Serial Port (USB)".
if not defined PORT (
  set "COUNT=0"
  for /f "tokens=1" %%P in ('arduino-cli board list ^| findstr /b /r "COM[0-9]" ^| findstr /i "USB" ^| findstr /i /v "ESP32"') do (
    set /a COUNT+=1 >nul
    set "CANDIDATE=%%P"
  )
  if "!COUNT!"=="1" set "PORT=!CANDIDATE!"
  if !COUNT! GTR 1 (
    echo [ERROR] Multiple USB serial ports found. Specify one: build.bat COM5 %MODE%
    arduino-cli board list
    goto :fail
  )
)
if not defined PORT (
  echo [ERROR] No USB-to-serial port found. Plug into the board's UART connector or use: build.bat COM5 %MODE%
  arduino-cli board list
  goto :fail
)
echo Using port %PORT%
if /i "%MODE%"=="monitor" goto :monitor

echo.
echo [2/3] Uploading to %PORT% at %UPLOAD_SPEED% baud
call arduino-cli upload -p "%PORT%" --fqbn "%FQBN%,UploadSpeed=%UPLOAD_SPEED%" --input-dir "%BUILD%" "%SKETCH%"
if errorlevel 1 (
  echo [ERROR] Upload failed. Close any open serial monitor; if needed hold BOOT, tap RESET, release BOOT.
  echo         Or try a lower speed: set SIP_UPLOAD_SPEED=115200
  goto :fail
)
if /i "%MODE%"=="upload" goto :done
timeout /t 2 /nobreak >nul

:monitor
echo.
echo [3/3] Serial monitor on %PORT% at %BAUD% baud. Press Ctrl+C to exit.
rem dtr/rts off so opening the monitor does not hold the chip in reset or boot mode.
call arduino-cli monitor -p "%PORT%" -c baudrate=%BAUD%,dtr=off,rts=off
if errorlevel 1 goto :fail
goto :done

:fail
echo.
if not defined NOPAUSE pause
endlocal
exit /b 1

:done
endlocal
exit /b 0
