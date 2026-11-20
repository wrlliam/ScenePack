"""Everything that touches ffmpeg: finding scenes, choosing clips, saving files."""

import ctypes
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from .config import APP_DIR, DEFAULT_TEMPLATE, DEFAULTS, FORMATS, QUALITY, log_error

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
GPU_NAMES = {"h264_nvenc": "NVIDIA", "h264_amf": "AMD", "h264_qsv": "Intel"}
SCAN_PART = 0.25  # share of a job's progress bar used by scanning


class Cancelled(Exception):
    pass


# --------------------------------------------------------------------------- small helpers

def safe_name(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(name)).strip().strip(".")
    return name[:180] or "clip"


def stamp(seconds):
    """Scene start time for file names, e.g. 00h12m34s (Windows file names cannot contain ':')."""
    t = int(max(seconds, 0))
    return f"{t // 3600:02d}h{t % 3600 // 60:02d}m{t % 60:02d}s"


def clock(seconds):
    t = int(max(seconds, 0))
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def fmt_left(seconds):
    seconds = int(max(seconds, 0))
    if seconds < 60:
        return "under a minute left"
    if seconds < 3600:
        return f"about {round(seconds / 60)} min left"
    return f"about {seconds // 3600} h {seconds % 3600 // 60} min left"


def threshold_from(sensitivity):
    return round(0.65 - 0.55 * min(max(float(sensitivity), 0.0), 1.0), 3)


class _Tokens(dict):
    def __missing__(self, key):
        return ""


def clip_name(template, tokens):
    """Build a file name (no extension) from the user's template."""
    tpl = (template or "").strip() or DEFAULT_TEMPLATE
    if "{num}" not in tpl and "{time}" not in tpl:
        tpl += "_{num}"  # keep names unique
    try:
        out = tpl.format_map(_Tokens(tokens))
    except (ValueError, IndexError, AttributeError):
        out = DEFAULT_TEMPLATE.format_map(_Tokens(tokens))
    out = re.sub(r"_{2,}", "_", out)
    out = re.sub(r"\s{2,}", " ", out).strip(" _-.")
    return safe_name(out)


def template_problem(template):
    """Human readable problem with a name template, or ''."""
    try:
        template.format_map(_Tokens(name="x", num="001", time="00h00m00s"))
    except (ValueError, IndexError, AttributeError):
        return "Curly brackets don't match up."
    unknown = set(re.findall(r"{(\w*)}", template)) - {"name", "num", "time", "show", "season", "episode", "code"}
    if unknown:
        return "Unknown tag: {" + sorted(unknown)[0] + "}"
    return ""


# --------------------------------------------------------------------------- ffmpeg discovery

def find_ffmpeg(custom=""):
    """Return (ffmpeg, ffprobe) paths or (None, None)."""
    from .config import ROOT
    candidates = []
    if custom:
        candidates.append(Path(custom).parent if Path(custom).is_file() else Path(custom))
    candidates += [ROOT / "ffmpeg", ROOT.parent / "ffmpeg", ROOT, ROOT / "bin", APP_DIR, APP_DIR / "bin"]  # installer ships resources/ffmpeg
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        candidates.append(Path(local) / "Microsoft" / "WinGet" / "Links")
        pk = Path(local) / "Microsoft" / "WinGet" / "Packages"
        if pk.is_dir():
            candidates += [p.parent for p in pk.glob("*FFmpeg*/*/bin/ffmpeg.exe")]
    candidates += [Path("C:/ffmpeg/bin"), Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "ffmpeg" / "bin"]
    for d in candidates:
        f, p = d / "ffmpeg.exe", d / "ffprobe.exe"
        if f.is_file() and p.is_file():
            return str(f), str(p)
    f, p = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if f and p:
        return f, p
    return None, None


def detect_gpu_encoder(ffmpeg):
    """Return the first hardware H.264 encoder that really works on this PC, or None."""
    for enc in ("h264_nvenc", "h264_amf", "h264_qsv"):
        try:
            r = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                                "color=s=256x256:d=0.2", "-c:v", enc, "-f", "null", "-"],
                               capture_output=True, stdin=subprocess.DEVNULL, timeout=30, creationflags=NO_WINDOW)
            if r.returncode == 0:
                return enc
        except Exception:
            pass
    return None


def probe(ffprobe, path):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries",
         "stream=codec_type,avg_frame_rate,r_frame_rate,width,height:format=duration", "-of", "json", path],
        capture_output=True, stdin=subprocess.DEVNULL, text=True, errors="replace", creationflags=NO_WINDOW)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "This file could not be read.")
    data = json.loads(out.stdout)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video:
        raise RuntimeError("No video found in this file.")

    def rate(r):
        try:
            n, d = r.split("/")
            return float(n) / float(d) if float(d) else 0.0
        except Exception:
            return 0.0

    fps = rate(video.get("avg_frame_rate", "0/0")) or rate(video.get("r_frame_rate", "0/0")) or 24.0
    return {"fps": fps, "duration": float(data.get("format", {}).get("duration") or 0),
            "width": int(video.get("width") or 0), "height": int(video.get("height") or 0),
            "has_audio": any(s.get("codec_type") == "audio" for s in streams)}


# --------------------------------------------------------------------------- process control

class Engine:
    """Starts ffmpeg processes and controls how hard they hit the PC (priority, threads, pause)."""
    PRIORITY = {"light": 0x00000040, "balanced": 0x00004000, "full": 0x00000020}

    def __init__(self, mode="balanced"):
        self.mode = mode
        self.paused = False
        self.procs = set()
        self.lock = threading.Lock()

    def threads(self):
        n = os.cpu_count() or 4
        return {"light": max(1, n // 4), "balanced": max(2, n // 2), "full": 0}[self.mode]

    @staticmethod
    def _nt(func, proc):
        try:
            getattr(ctypes.windll.ntdll, func)(ctypes.c_void_p(int(proc._handle)))
        except Exception:
            pass

    def wait_if_paused(self, token):
        while self.paused:
            if token.cancel.is_set():
                raise Cancelled()
            time.sleep(0.2)
        if token.cancel.is_set():
            raise Cancelled()

    def popen(self, cmd, token, **kw):
        self.wait_if_paused(token)
        kw.setdefault("stdin", subprocess.DEVNULL)  # never let ffmpeg read the app's message channel
        proc = subprocess.Popen(cmd, creationflags=NO_WINDOW | self.PRIORITY[self.mode], **kw)
        with self.lock:
            self.procs.add(proc)
            token.proc = proc
            if self.paused:
                self._nt("NtSuspendProcess", proc)
        return proc

    def release(self, proc, token):
        with self.lock:
            self.procs.discard(proc)
            token.proc = None

    def set_paused(self, paused):
        with self.lock:
            self.paused = paused
            for p in self.procs:
                self._nt("NtSuspendProcess" if paused else "NtResumeProcess", p)

    def set_mode(self, mode):
        with self.lock:
            self.mode = mode
            for p in self.procs:
                try:
                    ctypes.windll.kernel32.SetPriorityClass(ctypes.c_void_p(int(p._handle)), self.PRIORITY[mode])
                except Exception:
                    pass

    def kill(self, token):
        token.cancel.set()
        p = token.proc
        if p:
            try:
                p.kill()
            except Exception:
                pass

    def kill_all(self):
        with self.lock:
            for p in list(self.procs):
                try:
                    p.kill()
                except Exception:
                    pass


class Token:
    """Cancel flag + current process, for work that is not a queue job (e.g. AI search)."""

    def __init__(self):
        self.cancel = threading.Event()
        self.stop = threading.Event()  # "pause": finish early and keep what has been found so far
        self.proc = None


# --------------------------------------------------------------------------- scene detection

_PTS = re.compile(r"pts_time:\s*(-?[0-9.]+)")


def parse_scores(lines):
    """Parse ffmpeg `metadata=print` output into (times, scores)."""
    times, scores, t = [], [], None
    for line in lines:
        if line.startswith("frame:"):
            m = _PTS.search(line)
            t = float(m.group(1)) if m else None
        elif line.startswith("lavfi.scene_score=") and t is not None:
            try:
                scores.append(float(line.split("=", 1)[1]))
                times.append(t)
            except ValueError:
                pass
            t = None
    return times, scores


def analyze(engine, token, ffmpeg, path, duration, progress, hwaccel=False):
    """Score every frame for how much it differs from the one before -> (times, scores)."""
    th = engine.threads()
    cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-nostats"] + (["-threads", str(th)] if th else []) + \
          (["-hwaccel", "auto"] if hwaccel else []) + ["-i", path, "-map", "0:v:0", "-an", "-sn", "-dn",
           "-vf", "scale=320:-2:flags=fast_bilinear,select='gte(scene,0)',metadata=print:file=-",
           "-f", "null", "-"]
    proc = engine.popen(cmd, token, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace")
    err_tail = []

    def read_err():
        for line in proc.stderr:
            err_tail.append(line)
            del err_tail[:-20]

    reader = threading.Thread(target=read_err, daemon=True)
    reader.start()

    def lines():
        n = 0
        for line in proc.stdout:
            if token.cancel.is_set():
                proc.kill()
                raise Cancelled()
            if line.startswith("lavfi.scene_score="):
                n += 1
                if duration > 0 and n % 50 == 0:
                    m = _PTS.search(last[0]) if last[0] else None
                    if m:
                        progress(min(max(float(m.group(1)), 0) / duration, 1.0))
            elif line.startswith("frame:"):
                last[0] = line
            yield line

    last = [""]
    try:
        times, scores = parse_scores(lines())
        proc.wait()
        reader.join(timeout=5)
    finally:
        engine.release(proc, token)
    if token.cancel.is_set():
        raise Cancelled()
    if proc.returncode != 0 or not times:
        raise RuntimeError("This video could not be scanned.\n" + "".join(err_tail[-6:]).strip())
    return times, scores


def pick_cuts(times, scores, threshold):
    """A frame is a cut if it is the strongest change within +/-2 frames and either clears the
    threshold or is a clear spike above its neighbours (catches cuts between similar, dark shots)."""
    n = len(scores)
    cuts = []
    soft = max(threshold * 0.4, 0.04)
    for i in range(1, n):
        s = scores[i]
        if s < soft:
            continue
        if any(scores[j] > s for j in range(max(0, i - 2), min(n, i + 3))):
            continue
        nb = [scores[j] for j in range(max(0, i - 6), min(n, i + 7)) if j != i]
        avg = sum(nb) / len(nb) if nb else 0.0
        if s >= threshold or s >= avg * 4 + 0.03:
            cuts.append(times[i])
    return cuts


def build_scenes(cuts, duration, fps, min_len):
    """Turn cut times into [start, end] scenes, merging scenes shorter than min_len."""
    frame = 1.0 / fps
    bounds = [0.0] + [c for c in cuts if frame < c < duration - frame] + [duration]
    scenes = []
    for a, b in zip(bounds, bounds[1:]):
        if scenes and ((b - a) < min_len or (scenes[-1][1] - scenes[-1][0]) < min_len):
            scenes[-1][1] = b
        else:
            scenes.append([a, b])
    return scenes


def scenes_from_scan(times, scores, info, s):
    """Numbered scenes [[n, start, end], ...] using the user's detection settings."""
    duration = max(info["duration"], (times[-1] + 1.0 / info["fps"]) if times else 0)
    raw = build_scenes(pick_cuts(times, scores, threshold_from(s["sensitivity"])), duration, info["fps"],
                       s["min_len"])
    return [[i + 1, a, b] for i, (a, b) in enumerate(raw)]


def pick_scenes(scenes, duration, pick, seed=""):
    """Choose clips from one episode. pick = {count, mode, min_len, skip_start, skip_end} (seconds)."""
    count = int(pick.get("count") or 0)
    min_len = float(pick.get("min_len") or 0)
    lo_t = float(pick.get("skip_start") or 0)
    hi_t = duration - float(pick.get("skip_end") or 0)
    length = lambda x: x[2] - x[1]
    elig = [x for x in scenes if length(x) >= min_len and x[1] >= lo_t and x[2] <= hi_t]
    if not elig:
        elig = [x for x in scenes if length(x) >= min_len] or list(scenes)
    if count <= 0 or count >= len(elig):
        return elig
    mode = pick.get("mode", "spread")
    if mode == "longest":
        chosen = sorted(elig, key=length, reverse=True)[:count]
    elif mode == "random":
        rng = random.Random(hashlib.sha1(str(seed).encode()).hexdigest())
        chosen = rng.sample(elig, count)
    else:  # spread: one clip from each equal slice of the episode, the longest in that slice
        start, end = elig[0][1], elig[-1][2]
        seg = (end - start) / count
        chosen = []
        for k in range(count):
            inside = [x for x in elig if start + k * seg <= (x[1] + x[2]) / 2 < start + (k + 1) * seg
                      and x not in chosen]
            if inside:
                chosen.append(max(inside, key=length))
        for x in sorted(elig, key=length, reverse=True):
            if len(chosen) >= count:
                break
            if x not in chosen:
                chosen.append(x)
    return sorted(chosen, key=lambda x: x[1])


# --------------------------------------------------------------------------- export

def video_args(kind, quality, gpu):
    q = QUALITY[quality]
    if kind == "prores":
        return ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
    if kind == "dnxhr":
        return ["-c:v", "dnxhd", "-profile:v", "dnxhr_hq", "-pix_fmt", "yuv422p"]
    if gpu == "h264_nvenc":
        return ["-c:v", gpu, "-preset", "p5", "-rc", "vbr", "-cq", str(q + 3), "-b:v", "0", "-pix_fmt", "yuv420p"]
    if gpu == "h264_amf":
        g = str(q + 3)
        return ["-c:v", gpu, "-quality", "quality", "-rc", "cqp", "-qp_i", g, "-qp_p", g, "-qp_b", g,
                "-pix_fmt", "yuv420p"]
    if gpu == "h264_qsv":
        return ["-c:v", gpu, "-global_quality", str(q + 3), "-pix_fmt", "nv12"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", str(q), "-pix_fmt", "yuv420p"]


def scale_filter(max_height):
    if max_height:
        return f"scale=w=-2:h='trunc(min(ih,{int(max_height)})/2)*2'"
    return "scale=trunc(iw/2)*2:trunc(ih/2)*2"


def copy_ext(src):
    """Instant mode keeps the original streams, so it needs a container that can hold them."""
    ext = Path(src).suffix.lower()
    return ext if ext in (".mp4", ".mov", ".mkv", ".m4v", ".webm") else ".mkv"


def copy_scene(engine, job, ffmpeg, src, dst, start, end, s, audio):
    """No re-encoding: cut from the keyframe nearest the scene start. Many times faster, original quality."""
    tmp = dst + ".part"
    muxer = {".mp4": "mp4", ".m4v": "mp4", ".mov": "mov", ".webm": "webm"}.get(Path(dst).suffix.lower(), "matroska")
    cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.6f}", "-i", src,
           "-t", f"{max(end - start, 0.05):.6f}", "-map", "0:v:0"] + (["-map", "0:a:0?"] if audio else ["-an"]) + \
          ["-c", "copy", "-avoid_negative_ts", "make_zero", "-sn", "-dn", "-map_metadata", "-1", "-f", muxer, tmp]
    proc = engine.popen(cmd, job, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    try:
        while True:
            try:
                _, err = proc.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if job.cancel.is_set():
                    proc.kill()
                    proc.communicate()
                    raise Cancelled()
    finally:
        engine.release(proc, job)
    try:
        if proc.returncode != 0:
            raise RuntimeError(f"Could not save {Path(dst).name}:\n{err.strip()[-400:]}")
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def export_scene(engine, job, ffmpeg, src, dst, start, end, fps, s, audio, gpu):
    """Cut one scene, frame accurate. Writes to a .part file first so a stop never leaves half a clip."""
    ext, muxer, kind, aargs = FORMATS[s["format"]]
    if kind == "copy":
        return copy_scene(engine, job, ffmpeg, src, dst, start, end, s, audio)
    trim = s["trim_frames"]
    a = start + trim / fps
    frames = max(int(round((end - trim / fps - a) * fps)), 1)
    tmp = dst + ".part"

    def run(use_gpu):
        th = engine.threads()
        tharg = ["-threads", str(th)] if th else []
        cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"] + tharg + \
              ["-ss", f"{a:.6f}", "-i", src, "-t", f"{frames / fps:.6f}", "-frames:v", str(frames),
               "-map", "0:v:0", "-vf", scale_filter(s.get("max_height", 0))] + \
              video_args(kind, s["quality"], use_gpu) + tharg
        cmd += (["-map", "0:a:0?"] + aargs) if audio else ["-an"]
        if muxer == "mp4":
            cmd += ["-movflags", "+faststart"]
        cmd += ["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-f", muxer, tmp]
        proc = engine.popen(cmd, job, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                            errors="replace")
        try:
            while True:
                try:
                    _, err = proc.communicate(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    if job.cancel.is_set():
                        proc.kill()
                        proc.communicate()
                        raise Cancelled()
        finally:
            engine.release(proc, job)
        return proc.returncode, err

    try:
        code, err = run(gpu if kind == "h264" else None)
        if code != 0 and gpu and kind == "h264" and not job.cancel.is_set():
            log_error(f"GPU encode failed, retrying on CPU: {err.strip()[-300:]}")
            code, err = run(None)
        if job.cancel.is_set():
            raise Cancelled()
        if code != 0:
            raise RuntimeError(f"Could not save {Path(dst).name}:\n{err.strip()[-400:]}")
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# --------------------------------------------------------------------------- jobs

class Job:
    """One video in the queue.
    kind: film (whole film, every scene) | episode (TV, picked clips) | ai (scenes chosen in AI search)."""
    _next = 0

    def __init__(self, path, kind="film", title=None, subtitle="", dest=None, tokens=None, pick=None,
                 preset=None, key=None):
        Job._next += 1
        self.id = Job._next
        self.path = path
        self.kind = kind
        self.name = Path(path).name
        self.title = title or self.name
        self.subtitle = subtitle
        self.dest = dest
        self.tokens = tokens or {}
        self.pick = pick
        self.preset = preset
        self.key = key
        self.reset()

    def reset(self):
        self.state = "waiting"   # waiting | scanning | exporting | done | nocuts | error
        self.progress = 0.0
        self.message = ""
        self.folder = None
        self.total = 0
        self.done = 0
        self.t_export = None
        self.done_at_start = 0
        self.current = 0.0
        self.cancel = threading.Event()
        self.proc = None

    @property
    def active(self):
        return self.state in ("scanning", "exporting")

    def to_dict(self):
        return {"path": self.path, "kind": self.kind, "title": self.title, "subtitle": self.subtitle,
                "dest": self.dest, "tokens": self.tokens, "pick": self.pick, "preset": self.preset,
                "key": self.key}

    @classmethod
    def from_dict(cls, d):
        if isinstance(d, str):
            return cls(d)
        return cls(d["path"], d.get("kind", "film"), d.get("title"), d.get("subtitle", ""), d.get("dest"),
                   d.get("tokens"), d.get("pick"), d.get("preset"), d.get("key"))


MANIFEST = "_scenepack.json"


def find_pack_folder(root, stem, source, sig):
    """Pick the output folder for a whole film. Reuses a folder made earlier from the same film and
    settings, so a stopped film carries on where it left off instead of starting again."""
    k = 1
    while True:
        folder = root / (f"{stem}_scenepack" if k == 1 else f"{stem}_scenepack_{k}")
        if not folder.exists() or not any(folder.iterdir()):
            return folder, None
        try:
            m = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
            if m.get("source") == source and m.get("sig") == sig and m.get("scenes"):
                return folder, m["scenes"]
        except Exception:
            pass
        k += 1


def process_job(job, s, engine, ffmpeg, ffprobe, gpu):
    """Scan one video and save its scenes. Runs on a worker thread; updates fields on job."""
    job.state, job.message = "scanning", ""
    info = probe(ffprobe, job.path)
    stem = safe_name(Path(job.path).stem)
    tokens = {"name": stem, "show": "", "season": "", "episode": "", "code": ""}
    tokens.update(job.tokens or {})
    sig = {"threshold": threshold_from(s["sensitivity"]), "min_len": s["min_len"], "min_save": s["min_save"],
           "trim": s["trim_frames"], "format": s["format"], "quality": s["quality"], "audio": s["audio"],
           "height": s.get("max_height", 0), "names": s.get("name_template", DEFAULT_TEMPLATE),
           "pick": job.pick, "preset": hashlib.sha1(json.dumps(job.preset).encode()).hexdigest()
           if job.preset else None, "v": 3}

    scenes = None
    if job.dest:
        folder = Path(job.dest)
        manifest = folder / f"_scenepack_{safe_name(job.key or stem)}.json"
        try:
            m = json.loads(manifest.read_text(encoding="utf-8"))
            if m.get("source") == job.path and m.get("sig") == sig:
                scenes = m["scenes"]
        except Exception:
            pass
    else:
        root = Path(s["output_dir"] or DEFAULTS["output_dir"])
        folder, scenes = find_pack_folder(root, stem, job.path, sig)
        manifest = folder / MANIFEST

    if scenes is None:
        if job.preset:
            scenes = [list(x) for x in job.preset]
        else:
            prog = lambda p: setattr(job, "progress", p * SCAN_PART)
            try:  # decode on the graphics card when allowed: much faster on long films
                times, scores = analyze(engine, job, ffmpeg, job.path, info["duration"], prog, hwaccel=bool(s["gpu"] and gpu))
            except RuntimeError:
                if not (s["gpu"] and gpu) or job.cancel.is_set():
                    raise
                times, scores = analyze(engine, job, ffmpeg, job.path, info["duration"], prog)
            scenes = scenes_from_scan(times, scores, info, s)
            if len(scenes) < 2 and not job.pick:
                job.state = "nocuts"
                return
            if s["min_save"] > 0:
                scenes = [x for x in scenes if x[2] - x[1] >= s["min_save"]]
            if job.pick:
                scenes = pick_scenes(scenes, info["duration"], job.pick, seed=job.path)
        if not scenes:
            job.state = "nocuts"
            return
        folder.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"source": job.path, "sig": sig, "fps": info["fps"], "scenes": scenes}),
                            encoding="utf-8")

    job.folder = str(folder)
    job.total = len(scenes)
    job.state = "exporting"
    ext = FORMATS[s["format"]][0] or copy_ext(job.path)
    digits = max(3, len(str(max(int(x[0]) for x in scenes))))
    audio = s["audio"] and info["has_audio"]
    fps, trim = info["fps"], s["trim_frames"]
    todo = []
    for n, a, b in scenes:
        name = clip_name(s.get("name_template"), dict(tokens, num=f"{int(n):0{digits}d}", time=stamp(a)))
        dst = folder / (name + ext)
        if (b - a) - 2 * trim / fps < 1 / fps:
            continue  # scene shorter than the trim
        if dst.exists() and dst.stat().st_size > 0:
            continue  # already saved on an earlier run
        todo.append((str(dst), a, b))
    job.done = job.done_at_start = len(scenes) - len(todo)
    job.t_export = time.time()
    for dst, a, b in todo:
        job.current = a
        export_scene(engine, job, ffmpeg, job.path, dst, a, b, fps, s, audio, gpu if s["gpu"] else None)
        job.done += 1
        job.progress = SCAN_PART + (1 - SCAN_PART) * job.done / len(scenes)
    job.progress = 1.0
    job.state = "done"
