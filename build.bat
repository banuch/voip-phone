@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Adapted from AMR-PROJECT-FINAL\client\firmware\build.bat.
rem Usage: build.bat [COM5] [compile^|upload^|monitor^|all]
rem Also accepts: build.bat compile
rem Default: compile, upload, monitor. NOPAUSE=1 disables error pauses.
rem Override AUDIO_FQBN if your board needs different USB/flash/PSRAM settings.

set "FQBN=esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=default,PSRAM=opi"
if defined AUDIO_FQBN set "FQBN=%AUDIO_FQBN%"
set "BAUD=115200"
set "SKETCH=%~dp0ESP32S3_AudioWebTest"
set "BUILD=%~dp0.build\audio-web-batch"
set "RELEASE=%~dp0release"
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
if not exist "%SKETCH%\ESP32S3_AudioWebTest.ino" (
  echo [ERROR] Sketch missing: %SKETCH%
  goto :fail
)
if /i "%MODE%"=="monitor" goto :detect

echo.
echo [1/3] Compiling ESP32-S3 audio web test
echo Board: %FQBN%
call arduino-cli compile --fqbn "%FQBN%" --build-path "%BUILD%" --output-dir "%RELEASE%" "%SKETCH%"
if errorlevel 1 (
  echo [ERROR] Compile failed.
  goto :fail
)
echo Firmware images: %RELEASE%
if /i "%MODE%"=="compile" goto :done

:detect
rem Auto-select only an unambiguous ESP32 or USB serial port.
if not defined PORT (
  set "COUNT=0"
  for /f "tokens=1" %%P in ('arduino-cli board list ^| findstr /b /r "COM[0-9]" ^| findstr /i "ESP32"') do (
    set /a COUNT+=1 >nul
    set "CANDIDATE=%%P"
  )
  if "!COUNT!"=="1" set "PORT=!CANDIDATE!"
  if !COUNT! GTR 1 (
    echo [ERROR] Multiple ESP32 ports found. Specify one: build.bat COM5 %MODE%
    goto :fail
  )
)
if not defined PORT (
  set "COUNT=0"
  for /f "tokens=1" %%P in ('arduino-cli board list ^| findstr /b /r "COM[0-9]" ^| findstr /i "USB"') do (
    set /a COUNT+=1 >nul
    set "CANDIDATE=%%P"
  )
  if "!COUNT!"=="1" set "PORT=!CANDIDATE!"
  if !COUNT! GTR 1 (
    echo [ERROR] Multiple USB serial ports found. Specify one: build.bat COM5 %MODE%
    goto :fail
  )
)
if not defined PORT (
  echo [ERROR] No board port found. Connect the board or use: build.bat COM5 %MODE%
  goto :fail
)
echo Using port %PORT%
if /i "%MODE%"=="monitor" goto :monitor

echo.
echo [2/3] Uploading to %PORT%
call arduino-cli upload -p "%PORT%" --fqbn "%FQBN%" --input-dir "%BUILD%" "%SKETCH%"
if errorlevel 1 (
  echo [ERROR] Upload failed. Check the port; if needed hold BOOT, tap RESET, release BOOT.
  goto :fail
)
if /i "%MODE%"=="upload" goto :done
timeout /t 3 /nobreak >nul

:monitor
echo.
echo [3/3] Serial monitor on %PORT% at %BAUD% baud. Press Ctrl+C to exit.
call arduino-cli monitor -p "%PORT%" -c baudrate=%BAUD%
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
