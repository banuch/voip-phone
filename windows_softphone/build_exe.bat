@echo off
REM Builds a single-file Windows executable: dist\WintekSoftphone.exe
cd /d "%~dp0"
python -m pip install -r requirements.txt pyinstaller || exit /b 1
python -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name WintekSoftphone ^
  --collect-data sounddevice ^
  --collect-binaries sounddevice ^
  main.py || exit /b 1
echo.
echo Built: %~dp0dist\WintekSoftphone.exe
