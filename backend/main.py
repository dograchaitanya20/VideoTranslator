"""SubStream backend: video in -> real subtitles out (Whisper) -> translate (en/hi/pa).

Two engines, chosen automatically:
  * GROQ_API_KEY set  -> cloud mode (free hosted Whisper; tiny server, good for free hosting)
  * no key            -> local mode (faster-whisper on this computer; works offline)
"""
import io
import math
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def find_ffmpeg():
    """Use the system FFmpeg if present, otherwise the copy bundled with imageio-ffmpeg."""
    path = shutil.which("ffmpeg")
    if path:
        return path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


FFMPEG = find_ffmpeg()
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")  # local mode: tiny/base/small/medium/large-v3
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "whisper-large-v3")
USE_GROQ = bool(GROQ_API_KEY)
HOSTED = os.environ.get("HOSTED", "") == "1"                  # running on a public server
LANGS = {"en", "hi", "pa"}
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "300"))
MAX_MINUTES = int(os.environ.get("MAX_MINUTES", "20"))        # longest video accepted
JOB_TTL_HOURS = float(os.environ.get("JOB_TTL_HOURS", "6"))   # delete old files after this
YT_COOKIES = os.environ.get("YT_COOKIES", "")                 # optional cookies.txt path
PHONE_MODE = os.environ.get("ALLOW_PHONE", "1") == "1"        # let phones on the same Wi-Fi connect
BROWSER_OK = {".mp4", ".webm", ".m4v"}
LANG_CODES = {"english": "en", "hindi": "hi", "punjabi": "pa", "panjabi": "pa"}

app = FastAPI(title="SubStream")
JOBS: dict[str, dict] = {}
_model = None
_model_lock = threading.Lock()
TRANSCRIBE_LOCK = threading.Semaphore(1)  # one local transcription at a time (CPU is the bottleneck)


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            device = os.environ.get("WHISPER_DEVICE", "cpu")
            _model = WhisperModel(MODEL_NAME, device=device, compute_type="auto")
        return _model


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        lines = p.stderr.strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "command failed")


ANSI = re.compile(r"\x1b\[[0-9;]*m|\[[0-9;]*m")
FORMATS = [  # tried in order until one works
    "b[height<=720]/bv*[height<=720]+ba/b/ba",  # fast single stream or merged
    "ba/bestaudio",                            # audio only: still enough to make subtitles
]


def js_runtimes():
    for name in ("deno", "node"):
        path = shutil.which(name)
        if path:
            return {name: {"path": path}}
    return {}


def download_url(job, url, folder):
    import yt_dlp

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            if total > 0:
                job["progress"] = 2 + int(13 * min(1.0, downloaded / total))
            elif downloaded > 0:
                mb = downloaded / (1024 * 1024)
                job["progress"] = min(15, 2 + int(mb))
        elif d["status"] == "finished":
            job["progress"] = 16

    last = None
    for fmt in FORMATS:
        for f in folder.glob("source.*"):
            try:
                f.unlink(missing_ok=True)
            except Exception:
                pass
        opts = {
            "format": fmt, "merge_output_format": "mp4",
            "outtmpl": str(folder / "source.%(ext)s"),
            "noplaylist": True, "quiet": True, "no_warnings": True, "no_color": True,
            "ffmpeg_location": FFMPEG,
            "socket_timeout": 15,
            "retries": 3,
            "fragment_retries": 3,
            "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
            "js_runtimes": js_runtimes(),
            **({"cookiefile": YT_COOKIES} if YT_COOKIES and Path(YT_COOKIES).exists() else {}),
            "progress_hooks": [hook], "restrictfilenames": True,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                job["title"] = info.get("title") or "Video"
                path = Path(ydl.prepare_filename(info))
                if not path.exists():  # merged files can change extension
                    candidates = list(folder.glob("source.*"))
                    valid = [c for c in candidates if not c.name.endswith(".part")]
                    path = valid[0] if valid else candidates[0]
                job["audio_only"] = fmt.startswith("ba")
                return path
        except Exception as e:
            last = ANSI.sub("", str(e)).replace("ERROR:", "").strip()
    raise RuntimeError(
        f"Could not download this link ({last[:160] if last else 'unknown error'}). "
        "Try uploading the video file directly instead.")


def transcribe_local(wav, lang_hint, job):
    """faster-whisper on this computer. Returns (segments, language, duration)."""
    import numpy as np
    job.update(status="loading_model", progress=22)
    model = get_model()
    job.update(status="transcribing", progress=25)
    # load the 16 kHz mono WAV ourselves (avoids a PyAV version clash inside faster-whisper)
    with wave.open(str(wav), "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    segs, info = model.transcribe(
        audio, language=None if lang_hint == "auto" else lang_hint,
        vad_filter=True, beam_size=5)
    dur = info.duration or 1
    out = []
    for s in segs:
        text = s.text.strip()
        if not text:
            continue
        out.append({"start": round(s.start, 2), "end": round(s.end, 2),
                    "text": text, "conf": math.exp(s.avg_logprob)})
        job["progress"] = 25 + int(74 * min(1, s.end / dur))
    return out, info.language, dur


def transcribe_groq(audio_path, lang_hint):
    """Hosted Whisper (Groq free tier). Returns (segments, language, duration)."""
    import requests
    data = {"model": GROQ_MODEL, "response_format": "verbose_json", "temperature": "0"}
    if lang_hint != "auto":
        data["language"] = lang_hint
    with open(audio_path, "rb") as f:
        r = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (audio_path.name, f, "audio/mpeg")}, data=data, timeout=900)
    if r.status_code == 401:
        raise RuntimeError("The transcription API key is not valid.")
    if r.status_code == 429:
        raise RuntimeError("The free transcription limit was reached. Please try again later.")
    if r.status_code >= 400:
        raise RuntimeError(f"Transcription service error ({r.status_code}): {r.text[:150]}")
    j = r.json()
    lang = str(j.get("language", "")).lower()
    lang = LANG_CODES.get(lang, lang[:2])
    out = []
    for s in j.get("segments", []):
        text = (s.get("text") or "").strip()
        if text:
            out.append({"start": round(float(s["start"]), 2), "end": round(float(s["end"]), 2),
                        "text": text, "conf": math.exp(s.get("avg_logprob", -0.3))})
    dur = float(j.get("duration") or (out[-1]["end"] if out else 0)) or 1
    return out, lang, dur


def pipeline(job_id, src, url, lang_hint):
    job = JOBS[job_id]
    folder = DATA / job_id
    try:
        if url:
            job.update(status="downloading", progress=2)
            src = download_url(job, url, folder)
        else:
            job.update(status="converting", progress=5)

        play = src  # the browser must be able to play it
        if src.suffix.lower() not in BROWSER_OK and not HOSTED:  # skip the slow conversion on a weak free server
            job["status"] = "converting"
            play = folder / "preview.mp4"
            run([FFMPEG, "-y", "-i", str(src), "-c:v", "libx264", "-preset", "veryfast",
                 "-c:a", "aac", "-movflags", "+faststart", str(play)])
        job["media"] = str(play)

        job.update(status="extracting", progress=18)
        if USE_GROQ:  # small CBR mp3 (32 kbps = 4,000 bytes per second) to fit the 25 MB API limit
            audio_file = folder / "audio.mp3"
            run([FFMPEG, "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                 "-c:a", "libmp3lame", "-b:a", "32k", str(audio_file)])
            minutes = audio_file.stat().st_size / 4000 / 60
        else:         # 16 kHz 16-bit mono WAV = 32,000 bytes per second
            audio_file = folder / "audio.wav"
            run([FFMPEG, "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", str(audio_file)])
            minutes = audio_file.stat().st_size / 32000 / 60
        if minutes > MAX_MINUTES:
            raise RuntimeError(f"This video is {minutes:.0f} min long; the limit is {MAX_MINUTES} min.")
        if USE_GROQ and audio_file.stat().st_size > 24 * 1024 * 1024:
            raise RuntimeError("This video is too long for free cloud transcription.")

        if USE_GROQ:
            job.update(status="transcribing", progress=40)
            segs, src_lang, dur = transcribe_groq(audio_file, lang_hint)
        else:
            job.update(status="queued", progress=20)  # waits while another video is transcribing
            with TRANSCRIBE_LOCK:
                segs, src_lang, dur = transcribe_local(audio_file, lang_hint, job)

        if not segs:
            raise RuntimeError("No speech was detected in this video.")
        out = [{"id": i + 1, "start": s["start"], "end": s["end"], "orig": s["text"], "conf": s["conf"]}
               for i, s in enumerate(segs)]
        covered = sum(s["end"] - s["start"] for s in out)
        if src_lang in LANGS:
            for s in out:
                s[src_lang] = s["orig"]
        job.update(segments=out, source_lang=src_lang, duration=dur,
                   confidence=sum(s["conf"] for s in out) / len(out),
                   coverage=min(1.0, covered / dur), status="done", progress=100)
    except Exception as e:  # show a readable message in the UI
        import traceback; traceback.print_exc()  # also show the full error in the server log
        job.update(status="error", error=ANSI.sub("", str(e))[:400])


@app.post("/api/jobs")
async def create_job(file: UploadFile | None = File(None), url: str = Form(""),
                     lang: str = Form("auto")):
    if lang not in LANGS | {"auto"}:
        raise HTTPException(400, "Unsupported spoken language")
    url = url.strip()
    has_file = file is not None and bool(file.filename)
    if not has_file and not url:
        raise HTTPException(400, "Add a video file or a link")
    if not has_file and not re.match(r"^https?://", url, re.I):
        raise HTTPException(400, "Please paste a full http(s) link")

    job_id = uuid.uuid4().hex[:12]
    folder = DATA / job_id
    folder.mkdir(parents=True)
    src, title = None, "Video"
    if has_file:
        src = folder / f"source{Path(file.filename).suffix.lower() or '.mp4'}"
        size = 0
        with open(src, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_MB * 1024 * 1024:
                    f.close()
                    shutil.rmtree(folder, ignore_errors=True)
                    raise HTTPException(413, f"File too large (limit {MAX_UPLOAD_MB} MB)")
                f.write(chunk)
        title, url = file.filename, ""
    JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0, "title": title,
                    "segments": [], "source_lang": None}
    threading.Thread(target=pipeline, args=(job_id, src, url or None, lang), daemon=True).start()
    return {"id": job_id}


def public(job):
    return {k: v for k, v in job.items() if k != "media"}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return public(job)


@app.get("/api/jobs/{job_id}/media")
def job_media(job_id: str):
    job = JOBS.get(job_id)
    if not job or not job.get("media"):
        raise HTTPException(404, "Media not ready")
    return FileResponse(job["media"])  # supports Range requests, so seeking works


LANG_MAP = {"en": "English", "hi": "Hindi", "pa": "Punjabi"}


@app.post("/api/jobs/{job_id}/translate")
def translate(job_id: str, target: str):
    job = JOBS.get(job_id)
    if not job or job["status"] != "done":
        raise HTTPException(404, "Subtitles not ready")
    if target not in LANGS:
        raise HTTPException(400, "Unsupported target language")
    from translatepy import Translator as TpyTranslator
    translator = TpyTranslator()
    target_lang = LANG_MAP.get(target, target)
    todo = [s for s in job["segments"] if not s.get(target)]

    def one(s):
        try:
            result = translator.translate(s["orig"], target_lang)
            s[target] = str(result) or None
        except Exception:
            s[target] = None

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, todo))
    if todo and all(not s.get(target) for s in todo):
        raise HTTPException(502, "Translation service unreachable. Check your internet connection.")
    return public(job)


@app.put("/api/jobs/{job_id}/segment/{seg_id}")
def edit_segment(job_id: str, seg_id: int, lang: str, text: str):
    job = JOBS.get(job_id)
    if not job or lang not in LANGS:
        raise HTTPException(404, "Not found")
    for s in job["segments"]:
        if s["id"] == seg_id:
            s[lang] = text
    return {"ok": True}


def cleanup_loop():
    """Delete old job folders so the disk never fills up."""
    while True:
        cutoff = time.time() - JOB_TTL_HOURS * 3600
        for d in DATA.iterdir():
            try:
                if d.is_dir() and d.stat().st_mtime < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
                    JOBS.pop(d.name, None)
            except OSError:
                pass
        time.sleep(600)


threading.Thread(target=cleanup_loop, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": True}


def lan_ip():
    """The computer's address on the local network (no data is actually sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


@app.get("/api/connect")
def connect_info(request: Request):
    """Address + QR code so a phone can open the app (public link when hosted, LAN address otherwise)."""
    import qrcode
    import qrcode.image.svg
    if HOSTED:
        url = str(request.base_url).rstrip("/")
    else:
        url = f"http://{lan_ip()}:{request.url.port or 8000}"
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10)
    buf = io.BytesIO()
    img.save(buf)
    svg = buf.getvalue().decode()
    svg = svg[svg.index("<svg"):]  # drop the XML header so it can be inlined in the page
    return {"enabled": PHONE_MODE or HOSTED, "hosted": HOSTED, "url": url, "svg": svg}


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="static")