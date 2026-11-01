@echo off
cd /d "%~dp0"
title Video Subtitle Generator - close this window to stop the app
call config.bat
if not exist venv\Scripts\activate.bat (
  echo Please run setup.bat first.
  pause
  exit /b 1
)
call venv\Scripts\activate.bat
set HOST=127.0.0.1
if "%ALLOW_PHONE%"=="1" set HOST=0.0.0.0
start "" cmd /c "timeout /t 6 >nul & start http://127.0.0.1:8000"
echo.
if "%ALLOW_PHONE%"=="1" echo Phone: click "Use on phone" at the top of the page and scan the code.
echo.
pip install -U -q yt-dlp --disable-pip-version-check >nul 2>nul
python -m uvicorn backend.main:app --host %HOST% --port 8000
pause