@echo off
setlocal
cd /d "%~dp0"

python -m pip install -r requirements.txt
if errorlevel 1 exit /b 1

python -m unittest -v
if errorlevel 1 exit /b 1

python -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name CRAS-Desktop ^
  --collect-all webview ^
  --collect-all truststore ^
  --collect-all zeroconf ^
  --add-data "CRAS.html;." ^
  --add-data "dexie.min.js;." ^
  --add-data "manifest.webmanifest;." ^
  --add-data "sw.js;." ^
  --add-data "app-icon.svg;." ^
  --add-data "version.txt;." ^
  main.py
if errorlevel 1 exit /b 1

echo Executavel criado em dist\CRAS-Desktop.exe
