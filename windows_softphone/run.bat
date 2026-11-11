@echo off
cd /d "%~dp0"
python -c "import numpy, sounddevice, miniaudio" 2>nul || python -m pip install -r requirements.txt
start "" pythonw main.py
