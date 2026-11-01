@echo off
rem Settings. Change the model to "base" for a slow laptop, or "medium" for better Punjabi (slower).
set WHISPER_MODEL=small
set MAX_MINUTES=180
set MAX_UPLOAD_MB=4000
set JOB_TTL_HOURS=24
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
set ALLOW_PHONE=1
if exist secrets.bat call secrets.bat