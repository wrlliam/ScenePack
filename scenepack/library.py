"""The Library: every clip ScenePack has saved, grouped by folder, plus exporting picks into one place."""

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from .config import VIDEO_EXT
from .engine import NO_WINDOW, clock

_CLIP = re.compile(r"_scene_(\d+)_(\d{2})h(\d{2})m(\d{2})s$", re.I)
_META = {}  # (path, mtime) -> metadata


def _title(folder, root):
    """'Avatar_scenepack' -> 'Avatar';  'Show_scenepack/Season 01' -> 'Show  ·  Season 01'."""
    rel = Path(os.path.relpath(folder, root)) if folder != root else Path(Path(folder).name)
    parts = [p[:-len("_scenepack")] if p.lower().endswith("_scenepack") else p for p in rel.parts]
    parts = [re.sub(r"_scenepack_(\d+)$", r" (\1)", p, flags=re.I) for p in parts]
    return "  ·  ".join(p for p in parts if p and p != ".") or Path(folder).name


def _sources(folder):
    """Original videos this folder's clips came from (read from ScenePack's notes in the folder)."""
    out = []
    for m in Path(folder).glob("_scenepack*.json"):
        try:
            src = json.loads(m.read_text(encoding="utf-8")).get("source")
            if src and Path(src).name not in out:
                out.append(Path(src).name)
        except Exception:
            pass
    return out


def scan(roots):
    """Find every folder under the library roots that holds video clips."""
    groups, seen = [], set()
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for dirpath, dirnames, files in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            key = os.path.normcase(os.path.abspath(dirpath))
            if key in seen:
                continue
            clips = []
            for f in files:
                p = Path(dirpath) / f
                if p.suffix.lower() not in VIDEO_EXT or f.endswith(".part"):
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                m = _CLIP.search(p.stem)
                clips.append({
                    "path": str(p), "name": p.name, "size": st.st_size, "mtime": st.st_mtime,
                    "scene": int(m.group(1)) if m else None,
                    "start": f"{m.group(2)}:{m.group(3)}:{m.group(4)}" if m else None,
                })
            if not clips:
                continue
            seen.add(key)
            clips.sort(key=lambda c: (c["scene"] is None, c["scene"] or 0, c["name"].lower()))
            groups.append({
                "id": hashlib.sha1(key.encode()).hexdigest()[:12], "path": dirpath, "root": root,
                "title": _title(dirpath, root), "sources": _sources(dirpath), "clips": clips,
                "count": len(clips), "size": sum(c["size"] for c in clips), "mtime": max(c["mtime"] for c in clips),
            })
    groups.sort(key=lambda g: -g["mtime"])
    return groups


def meta(ffprobe, path):
    """Length, picture size, frame rate and codecs of one clip (cached)."""
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return None
    key = (path, mtime)
    if key in _META:
        return _META[key]
    r = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                        "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration",
                        "-of", "json", path], capture_output=True, stdin=subprocess.DEVNULL, text=True,
                       errors="replace", creationflags=NO_WINDOW, timeout=30)
    if r.returncode != 0:
        return None
    data = json.loads(r.stdout or "{}")
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    a = next((s for s in streams if s.get("codec_type") == "audio"), {})
    try:
        n, d = (v.get("avg_frame_rate") or "0/1").split("/")
        fps = round(float(n) / float(d), 2) if float(d) else 0
    except ValueError:
        fps = 0
    dur = float(data.get("format", {}).get("duration") or 0)
    out = {"duration": round(dur, 2), "length": clock(dur) if dur >= 60 else f"{dur:.1f} s",
           "width": v.get("width"), "height": v.get("height"), "fps": fps,
           "vcodec": (v.get("codec_name") or "").upper().replace("H264", "H.264").replace("HEVC", "H.265"),
           "acodec": (a.get("codec_name") or "").upper() if a else ""}
    _META[key] = out
    return out


def _free_name(dest_dir, name):
    target = dest_dir / name
    stem, ext = Path(name).stem, Path(name).suffix
    k = 2
    while target.exists():
        target = dest_dir / f"{stem} ({k}){ext}"
        k += 1
    return target


def export(items, dest, mode="copy", subfolders=False, progress=None, cancel=None):
    """Copy (or move) clips into one folder, optionally one sub-folder per film or season.
    items: paths, or {"path": ..., "group": "Film name"} dicts (group names the sub-folder)."""
    from .engine import safe_name
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    done, skipped, total_bytes = 0, [], 0
    for i, item in enumerate(items):
        p = item["path"] if isinstance(item, dict) else item
        group = item.get("group") if isinstance(item, dict) else None
        if cancel is not None and cancel.is_set():
            break
        src = Path(p)
        if not src.is_file():
            skipped.append(src.name)
            continue
        folder = dest
        if subfolders:
            folder = dest / safe_name((group or _title(str(src.parent), str(src.parent.parent))).replace("  ·  ", " - "))
            folder.mkdir(parents=True, exist_ok=True)
        target = _free_name(folder, src.name)
        try:
            if mode == "move":
                shutil.move(str(src), str(target))
            else:
                shutil.copy2(str(src), str(target))
            done += 1
            total_bytes += target.stat().st_size
        except OSError as e:
            skipped.append(f"{src.name} ({e.strerror or e})")
        if progress:
            progress(i + 1, len(items), src.name)
    return {"done": done, "skipped": skipped, "dest": str(dest), "bytes": total_bytes}
