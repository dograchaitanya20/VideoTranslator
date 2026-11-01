@echo off
cd /d "%~dp0"
title Video Subtitle Generator - one-time setup
call config.bat

echo ==== One-time setup: needs internet, takes 5 to 15 minutes ====
echo.

set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY (
  python --version >nul 2>nul && set "PY=python"
)
if not defined PY goto nopython

if not exist venv (
  echo Creating the app environment...
  %PY% -m venv venv
  if errorlevel 1 goto fail
)
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 goto fail

echo.
echo Downloading the speech model (one time, several hundred MB)...
python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')"
if errorlevel 1 goto fail

where node >nul 2>nul
if errorlevel 1 (
  where winget >nul 2>nul
  if not errorlevel 1 (
    echo Installing Node.js, which YouTube downloads need...
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  )
)

echo Creating a desktop shortcut...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Video Subtitles.lnk'); $s.TargetPath='%~dp0start.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()"

echo.
echo ==== Setup finished! Use the "Video Subtitles" icon on your Desktop. ====
pause
exit /b 0

:nopython
echo Python is not installed.
where winget >nul 2>nul
if errorlevel 1 (
  echo Please install Python from https://www.python.org/downloads/
  echo IMPORTANT: tick "Add python.exe to PATH" in the installer, then run setup.bat again.
  pause
  exit /b 1
)
echo Installing Python 3.12 now...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
echo.
echo Python is installed. CLOSE this window, then double-click setup.bat again.
pause
exit /b 1

:fail
echo.
echo Something went wrong. Take a photo or screenshot of this window and send it to Chaitanya.
pause
exit /b 1