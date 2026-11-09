@echo off
cd /d "%~dp0"
if exist "runtime\python\python.exe" (
  "runtime\python\python.exe" -c "import edge_tts, requests, websocket, betterproto, mini_racer; print('Runtime OK')"
) else (
  py -3 -m venv .venv
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
pause
