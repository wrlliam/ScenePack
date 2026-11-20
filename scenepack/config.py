"""Paths, settings and colours shared by the whole app."""

import json
import os
import sys
import time
from pathlib import Path

from . import APP_NAME

FROZEN = getattr(sys, "frozen", False)
ROOT = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parent.parent
ASSETS = Path(getattr(sys, "_MEIPASS", ROOT)) / "assets"
APP_DIR = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
SETTINGS_FILE = APP_DIR / "settings.json"
LOG_FILE = APP_DIR / "scenepack.log"
CACHE_DIR = APP_DIR / "cache"
MODEL_DIR = APP_DIR / "models"

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".mxf", ".wmv", ".flv", ".ts", ".mts", ".m2ts",
             ".mpg", ".mpeg"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

# label -> ext, ffmpeg muxer, video kind, audio args
FORMATS = {
    "MP4  -  H.264 (works everywhere)": (".mp4", "mp4", "h264", ["-c:a", "aac", "-b:a", "320k"]),
    "MOV  -  H.264 + uncompressed audio": (".mov", "mov", "h264", ["-c:a", "pcm_s16le"]),
    "MOV  -  ProRes 422 HQ (editing, big files)": (".mov", "mov", "prores", ["-c:a", "pcm_s16le"]),
    "MOV  -  DNxHR HQ (editing, big files)": (".mov", "mov", "dnxhr", ["-c:a", "pcm_s16le"]),
    # no re-encoding: many times faster and identical quality, but each clip starts on the nearest keyframe
    "Instant  -  original quality, no re-encoding (cuts land on keyframes)": (None, None, "copy", ["-c:a", "copy"]),
}
QUALITY = {"High": 18, "Very high": 14, "Near-lossless": 10}  # x264 CRF
RESOLUTIONS = {"Original": 0, "4K": 2160, "1440p": 1440, "1080p": 1080, "720p": 720, "480p": 480}
DEFAULT_TEMPLATE = "{name}_scene_{num}_{time}"

DEFAULTS = {
    # output
    "output_dir": str(Path.home() / "Videos" / "ScenePacks"),
    "format": next(iter(FORMATS)),
    "quality": "Very high",
    "max_height": 0,
    "audio": True,
    "gpu": True,
    "name_template": DEFAULT_TEMPLATE,
    # scene detection
    "sensitivity": 0.64,       # 0 = fewer cuts ... 1 = more cuts
    "min_len": 0.5,            # scenes shorter than this are merged into a neighbour
    "min_save": 0.0,           # scenes shorter than this are not saved
    "trim_frames": 0,
    # background work
    "parallel": 1,
    "mode": "balanced",        # light | balanced | full
    "keep_awake": True,
    # when finished
    "notify": True,
    "open_when_done": False,
    # TV shows
    "tv_count": 4,
    "tv_all": False,
    "tv_mode": "spread",       # spread | longest | random
    "tv_min_len": 1.5,
    "tv_skip_start": 0.0,      # minutes
    "tv_skip_end": 0.0,        # minutes
    "tv_layout": "seasons",    # seasons | flat
    # AI search
    "ai_model": "fast",
    "ai_detail": "normal",
    "ai_strict": 0.5,
    "ai_device": "auto",       # auto | gpu | cpu
    # appearance / app
    "theme": "dark",           # dark | light
    "ui_scale": 0.9,           # interface size (window zoom): 0.8 compact ... 1.15 large
    "auto_start": True,        # start the queue as soon as something is added
    "keep_in_tray": True,      # closing the window while working keeps going in the tray
    "auto_update": True,
    "welcome_done": False,
    "library_dirs": [],        # extra folders shown in the Library (the output folder is always included)
    "animations": True,
    "remember_queue": True,
    "confirm_quit": True,
    "ffmpeg": "",
    "queue": [],
}

def log_error(text):
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}\n")
    except Exception:
        pass


def load_settings():
    s = dict(DEFAULTS)
    try:
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        s.update({k: v for k, v in saved.items() if k in DEFAULTS})
    except Exception:
        pass
    checks = {"format": FORMATS, "quality": QUALITY, "theme": ("dark", "light"), "ai_device": ("auto", "gpu", "cpu"),
              "mode": ("light", "balanced", "full"), "tv_mode": ("spread", "longest", "random"),
              "tv_layout": ("seasons", "flat"), "ai_model": ("fast", "accurate"),
              "ai_detail": ("fast", "normal", "detailed")}
    for key, allowed in checks.items():
        if s[key] not in allowed:
            s[key] = DEFAULTS[key]
    if s["ui_scale"] not in (0.8, 0.9, 1, 1.0, 1.15):
        s["ui_scale"] = DEFAULTS["ui_scale"]
    if s["max_height"] not in RESOLUTIONS.values():
        s["max_height"] = 0
    return s


def save_settings(s):
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
        os.replace(tmp, SETTINGS_FILE)
    except Exception as e:
        log_error(f"could not save settings: {e}")
