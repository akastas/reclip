"""ReClip — yt-dlp FastAPI wrapper."""
import asyncio
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from yt_dlp import YoutubeDL

# ---------------------------------------------------------------------------
# Paths & config
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = Path(os.environ.get("RECLIP_DOWNLOADS", "/opt/reclip/downloads"))
DB_PATH = Path(os.environ.get("RECLIP_DB", "/opt/reclip/reclip.db"))
COOKIES_FILE = Path(os.environ.get("RECLIP_COOKIES", "/opt/reclip/cookies.txt"))
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Format presets: maps UI label -> yt-dlp format selector & postprocessors
FORMAT_PRESETS = {
    "best": {
        "label": "Best MP4",
        "ydl": {
            "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
            "merge_output_format": "mp4",
        },
    },
    "1080p": {
        "label": "1080p MP4",
        "ydl": {
            "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
            "merge_output_format": "mp4",
        },
    },
    "720p": {
        "label": "720p MP4",
        "ydl": {
            "format": "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b",
            "merge_output_format": "mp4",
        },
    },
    "480p": {
        "label": "480p MP4",
        "ydl": {
            "format": "bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/b",
            "merge_output_format": "mp4",
        },
    },
    "mp3-320": {
        "label": "MP3 320 kbps",
        "ydl": {
            "format": "ba/b",
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "320"}
            ],
        },
    },
    "mp3-192": {
        "label": "MP3 192 kbps",
        "ydl": {
            "format": "ba/b",
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
            ],
        },
    },
    "m4a": {
        "label": "M4A (original audio)",
        "ydl": {
            "format": "ba[ext=m4a]/ba/b",
        },
    },
}


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def db_init():
    with db() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                preset TEXT NOT NULL,
                title TEXT,
                uploader TEXT,
                thumbnail TEXT,
                duration INTEGER,
                filename TEXT,
                filesize INTEGER,
                status TEXT NOT NULL,
                error TEXT,
                created_at INTEGER NOT NULL,
                completed_at INTEGER
            )"""
        )
        c.commit()


# ---------------------------------------------------------------------------
# In-memory job tracking for WebSocket progress
# ---------------------------------------------------------------------------
class JobState:
    def __init__(self, job_id: str):
        self.job_id = job_id
        self.queue: asyncio.Queue = asyncio.Queue()
        self.done = False

    async def put(self, event: dict):
        await self.queue.put(event)

    def put_threadsafe(self, loop: asyncio.AbstractEventLoop, event: dict):
        asyncio.run_coroutine_threadsafe(self.queue.put(event), loop)


JOBS: dict[str, JobState] = {}


# ---------------------------------------------------------------------------
# Download worker (runs in a thread — yt-dlp is sync)
# ---------------------------------------------------------------------------
def _safe_filename(name: str) -> str:
    return re.sub(r"[^\w\-. ]", "_", name)[:120]


def run_download(job_id: str, url: str, preset_key: str, subtitles: bool, loop: asyncio.AbstractEventLoop):
    state = JOBS[job_id]

    if preset_key.startswith("id:"):
        preset = {
            "ydl": {
                "format": preset_key[3:],
                # Default to mkv for arbitrary merges if formats clash, but mp4 usually preferred
                "merge_output_format": "mp4" 
            }
        }
    else:
        preset = FORMAT_PRESETS.get(preset_key, FORMAT_PRESETS["best"])

    job_dir = DOWNLOADS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            pct = (downloaded / total * 100) if total else 0
            state.put_threadsafe(loop, {
                "type": "progress",
                "pct": round(pct, 1),
                "downloaded": downloaded,
                "total": total,
                "speed": d.get("speed"),
                "eta": d.get("eta"),
            })
        elif d["status"] == "finished":
            state.put_threadsafe(loop, {"type": "postprocess"})

    ydl_opts = {
        "outtmpl": str(job_dir / "%(title).100B.%(ext)s"),
        "progress_hooks": [hook],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "nopart": False,
        "restrictfilenames": False,
        "windowsfilenames": True,
        # Mitigations for YouTube bot detection on datacenter IPs:
        # - ios client often has less aggressive checks
        # - web_safari as fallback
        "extractor_args": {
            "youtube": {"player_client": ["ios", "web_safari", "web"]},
        },
    }
    # If a cookies.txt is present, use it (bypasses YouTube bot wall)
    if COOKIES_FILE.exists():
        ydl_opts["cookiefile"] = str(COOKIES_FILE)
    ydl_opts.update(preset["ydl"])

    if subtitles:
        ydl_opts["writesubtitles"] = True
        ydl_opts["writeautomaticsub"] = True
        ydl_opts["subtitleslangs"] = ["en", "ru", "uk", "it"]
        ydl_opts["subtitlesformat"] = "srt/best"

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if "entries" in info:
                info = info["entries"][0]
            filepath = Path(ydl.prepare_filename(info))
            # After postprocessing the extension may change (e.g. .mp3)
            if not filepath.exists():
                candidates = list(job_dir.glob(f"{filepath.stem}.*"))
                if candidates:
                    filepath = candidates[0]

        filesize = filepath.stat().st_size if filepath.exists() else 0
        with db() as c:
            c.execute(
                """UPDATE jobs SET status=?, title=?, uploader=?, thumbnail=?,
                   duration=?, filename=?, filesize=?, completed_at=? WHERE id=?""",
                (
                    "done",
                    info.get("title"),
                    info.get("uploader") or info.get("channel"),
                    info.get("thumbnail"),
                    info.get("duration"),
                    filepath.name,
                    filesize,
                    int(time.time()),
                    job_id,
                ),
            )
            c.commit()

        state.put_threadsafe(loop, {
            "type": "done",
            "job_id": job_id,
            "filename": filepath.name,
            "filesize": filesize,
            "title": info.get("title"),
        })
    except Exception as e:
        err = str(e)[:500]
        with db() as c:
            c.execute("UPDATE jobs SET status=?, error=?, completed_at=? WHERE id=?",
                      ("error", err, int(time.time()), job_id))
            c.commit()
        state.put_threadsafe(loop, {"type": "error", "error": err})
    finally:
        state.put_threadsafe(loop, {"type": "end"})
        state.done = True


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    db_init()
    yield


app = FastAPI(title="ReClip", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


class DownloadRequest(BaseModel):
    url: str
    preset: str = "best"
    subtitles: bool = False

class InfoRequest(BaseModel):
    url: str

def get_video_info(url: str):
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_args": {
            "youtube": {"player_client": ["ios", "web_safari", "web"]},
        },
    }
    if COOKIES_FILE.exists():
        ydl_opts["cookiefile"] = str(COOKIES_FILE)

    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        
    best_audio = None
    for f in reversed(info.get('formats', [])):
        if f.get('acodec') != 'none' and f.get('vcodec') == 'none':
            if not best_audio or f.get('abr', 0) > best_audio.get('abr', 0):
                best_audio = f

    options = []
    heights_seen = set()
    
    for f in sorted(info.get('formats', []), key=lambda x: x.get('height') or 0, reverse=True):
        if f.get('vcodec') != 'none':
            h = f.get('height')
            if not h or h in heights_seen:
                continue
                
            size = f.get('filesize') or f.get('filesize_approx') or 0
            audio_size = best_audio.get('filesize') or best_audio.get('filesize_approx') or 0 if best_audio else 0
            
            if f.get('acodec') != 'none':
                total_size = size
                fmt_id = f['format_id']
            else:
                total_size = size + audio_size
                fmt_id = f"{f['format_id']}+{best_audio['format_id']}" if best_audio else f['format_id']
                
            ext = f.get('ext', 'mp4')
            fps = f.get('fps', 0)
            
            label = f"{h}p" + (f"60" if fps and fps > 30 else "") + f" ({ext.upper()})"
            options.append({
                'label': label,
                'id': f"id:{fmt_id}",
                'size': total_size,
                'height': h
            })
            heights_seen.add(h)
    
    if best_audio:
        size = best_audio.get('filesize') or best_audio.get('filesize_approx') or 0
        options.append({
            'label': f"Audio Only ({best_audio.get('ext', 'mp3').upper()})",
            'id': f"id:{best_audio['format_id']}",
            'size': size,
            'height': 0
        })

    # Always ensure a fallback generic option if parsing yields zero mapped formats
    if not options:
        options.append({'label': 'Best Auto', 'id': 'best', 'size': 0, 'height': 0})

    return {
        "title": info.get("title", ""),
        "thumbnail": info.get("thumbnail", ""),
        "duration": info.get("duration", 0),
        "host": info.get("extractor_key", ""),
        "options": options
    }

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "presets": FORMAT_PRESETS,
    })


@app.post("/api/info")
async def fetch_info(req: InfoRequest):
    if not re.match(r"^https?://", req.url.strip()):
        raise HTTPException(400, "URL must start with http(s)://")
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, get_video_info, req.url.strip())
        return data
    except Exception as e:
        raise HTTPException(500, str(e)[:500])

@app.post("/api/download")
async def start_download(req: DownloadRequest):
    if not req.preset.startswith("id:") and req.preset not in FORMAT_PRESETS:
        raise HTTPException(400, "Unknown preset")
    if not re.match(r"^https?://", req.url.strip()):
        raise HTTPException(400, "URL must start with http(s)://")

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = JobState(job_id)

    with db() as c:
        c.execute(
            """INSERT INTO jobs (id, url, preset, status, created_at)
               VALUES (?, ?, ?, 'running', ?)""",
            (job_id, req.url.strip(), req.preset, int(time.time())),
        )
        c.commit()

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, run_download, job_id, req.url.strip(), req.preset, req.subtitles, loop)
    return {"job_id": job_id}


@app.websocket("/ws/progress/{job_id}")
async def ws_progress(ws: WebSocket, job_id: str):
    await ws.accept()
    state = JOBS.get(job_id)
    if not state:
        await ws.send_json({"type": "error", "error": "unknown job"})
        await ws.close()
        return
    try:
        while True:
            event = await state.queue.get()
            await ws.send_json(event)
            if event.get("type") == "end":
                break
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


@app.get("/api/jobs")
async def list_jobs():
    with db() as c:
        rows = c.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # Check if file still exists on disk
        if d["filename"]:
            path = DOWNLOADS_DIR / d["id"] / d["filename"]
            d["file_exists"] = path.exists()
        else:
            d["file_exists"] = False
        out.append(d)
    return out


@app.get("/download/{job_id}")
async def download_file(job_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row or not row["filename"]:
        raise HTTPException(404, "Not found")
    path = DOWNLOADS_DIR / job_id / row["filename"]
    if not path.exists():
        raise HTTPException(410, "File expired (auto-deleted after 24h)")
    return FileResponse(
        path,
        filename=_safe_filename(row["filename"]),
        media_type="application/octet-stream",
    )


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        c.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        c.commit()
    job_dir = DOWNLOADS_DIR / job_id
    if job_dir.exists():
        for f in job_dir.iterdir():
            try:
                f.unlink()
            except Exception:
                pass
        try:
            job_dir.rmdir()
        except Exception:
            pass
    return {"ok": True}


@app.get("/health")
async def health():
    return {"ok": True}
