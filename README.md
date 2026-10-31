# SubStream.ai — real AI subtitles in English, Hindi & Punjabi

Upload a video (WhatsApp, phone, PC) or paste a YouTube/web link → speech is transcribed with
**Whisper (faster-whisper)** → switch captions between **English / हिन्दी / ਪੰਜਾਬੀ**.

## 1. Install once
1. Python 3.10+  (https://python.org — tick "Add to PATH")
2. FFmpeg  — Windows: `winget install Gyan.FFmpeg`  (then reopen the terminal; check `ffmpeg -version`)
3. In this folder:
```
python -m venv venv
venv\Scripts\activate          (Mac/Linux: source venv/bin/activate)
pip install -r requirements.txt
```

## 2. Run
```
uvicorn backend.main:app --port 8000
```
Open http://localhost:8000

First run downloads the Whisper model (~500 MB for `small`). Needs internet for model download,
translation (Google Translate via deep-translator) and link downloads.

## Accuracy tips
- Set "Spoken" language manually if auto-detect guesses wrong (short clips, music).
- Punjabi is Whisper's weakest of the three. For better results: `set WHISPER_MODEL=medium`
  (or `large-v3` on a GPU) before starting. Bigger = slower.
- Subtitles are editable: click any line's text, fix it, and exports use your edits.

## Files
- `backend/main.py` — API: upload/link → yt-dlp → ffmpeg → Whisper → translation
- `frontend/` — the UI (index.html, styles.css, app.js)
