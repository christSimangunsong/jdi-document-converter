@echo off
rem Jalankan sidecar (deskew 5002 + table-ocr 5003) di 2 jendela terpisah.
rem Alternatif: npm run sidecars, atau otomatis via npm start (SIDECAR_AUTOSTART=true).
cd /d "%~dp0"
set "PYTHON_BIN="
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if "%%a"=="PYTHON_BIN" set "PYTHON_BIN=%%b"
)
if "%PYTHON_BIN%"=="" set "PYTHON_BIN=python"
start "sidecar-table-ocr" "%PYTHON_BIN%" "%~dp0sidecar\table_ocr\run_server.py"
start "sidecar-deskew" "%PYTHON_BIN%" "%~dp0sidecar\run_deskew.py"
echo Sidecar dijalankan di jendela terpisah (port 5002 & 5003).
echo Tutup jendelanya untuk menghentikan.
