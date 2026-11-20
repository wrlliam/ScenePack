"""ScenePack backend. The Electron app starts this and talks to it with one JSON message per line.

  app -> backend:  {"id": 7, "method": "queue.addFilms", "params": {"paths": [...]}}
  backend -> app:  {"id": 7, "result": {...}}   or   {"id": 7, "error": "message"}
  backend -> app:  {"event": "jobs", "data": {...}}   (pushed whenever something changes)

Run:  python -m scenepack.server
"""

import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

from . import APP_NAME, REPO_URL, VERSION, ai, library
from .config import (CACHE_DIR, DEFAULTS, FORMATS, QUALITY, RESOLUTIONS, SETTINGS_FILE, APP_DIR, load_settings,
                     log_error, save_settings)
from .engine import (GPU_NAMES, NO_WINDOW, SCAN_PART, Cancelled, Engine, Job, Token, clip_name, clock,
                     detect_gpu_encoder, find_ffmpeg, fmt_left, probe, process_job, safe_name, scenes_from_scan,
                     stamp, template_problem)
from .tv import collect_videos, episode_code, group_episodes, parse_episode


class Server:
    def __init__(self, out):
        self.out = out
        self.out_lock = threading.Lock()
        self.settings = load_settings()
        self.engine = Engine(self.settings["mode"])
        self.ai_engine = Engine(self.settings["mode"])  # AI search is never paused by the queue's Pause
        self.ffmpeg, self.ffprobe = find_ffmpeg(self.settings.get("ffmpeg", ""))
        self.gpu, self.gpu_checked = None, False
        self.jobs, self.running, self.finished = [], False, ""
        self.awake = False
        self.ai_token, self.ai_busy = None, False
        self.videos, self.refs, self.text, self.query = [], [], None, ""
        self.thumb_lock = threading.Lock()
        saved = self.settings.get("queue", []) if self.settings["remember_queue"] else []
        for d in saved:
            try:
                self.jobs.append(Job.from_dict(d))
            except Exception:
                pass
        if self.ffmpeg:
            threading.Thread(target=self._find_gpu, daemon=True).start()
        threading.Thread(target=self._scheduler, daemon=True).start()

    # ------------------------------------------------------------------ io
    def send(self, obj):
        line = json.dumps(obj, ensure_ascii=False)
        with self.out_lock:
            self.out.write(line + "\n")
            self.out.flush()

    def emit(self, event, data=None):
        self.send({"event": event, "data": data})

    def handle(self, msg):
        mid, method, params = msg.get("id"), msg.get("method", ""), msg.get("params") or {}
        fn = getattr(self, "m_" + method.replace(".", "_"), None)
        if not fn:
            self.send({"id": mid, "error": f"Unknown method {method}"})
            return

        def run():
            try:
                self.send({"id": mid, "result": fn(**params)})
            except Cancelled:
                self.send({"id": mid, "error": "cancelled"})
            except Exception as e:
                log_error(f"{method}: {traceback.format_exc()}")
                self.send({"id": mid, "error": str(e).splitlines()[0][:300] if str(e) else repr(e)})

        if getattr(fn, "slow", False):
            threading.Thread(target=run, daemon=True).start()
        else:
            run()

    def save(self):
        s = self.settings
        s["queue"] = [j.to_dict() for j in self.jobs if j.state != "done"] if s["remember_queue"] else []
        save_settings(s)

    # ------------------------------------------------------------------ app
    def _find_gpu(self):
        self.gpu = detect_gpu_encoder(self.ffmpeg)
        self.gpu_checked = True
        self.emit("status", self.status())

    def status(self):
        dev = ai.resolve_device(self.settings["ai_device"]) if ai.available() else "cpu"
        key = self.settings["ai_model"]
        return {
            "ffmpeg": self.ffmpeg, "gpu": GPU_NAMES.get(self.gpu) if self.gpu else None, "gpuChecked": self.gpu_checked,
            "ai": {"available": ai.available(), "gpu": ai.gpu_available() if ai.available() else False,
                   "device": dev, "installed": ai.installed(key, dev) if ai.available() else False,
                   "size": ai.MODELS[key]["size"][dev], "label": ai.MODELS[key]["label"],
                   "cacheMB": round(sum(f.stat().st_size for f in CACHE_DIR.rglob("*") if f.is_file()) / 1e6)
                   if CACHE_DIR.exists() else 0, "busy": self.ai_busy},
        }

    def m_app_init(self):
        return {"version": VERSION, "name": APP_NAME, "repo": REPO_URL, "settings": self.public_settings(),
                "options": {"formats": list(FORMATS), "qualities": list(QUALITY), "resolutions": RESOLUTIONS},
                "status": self.status(), "jobs": self.snapshot(), "appDir": str(APP_DIR)}

    def public_settings(self):
        return {k: v for k, v in self.settings.items() if k != "queue"}

    def m_settings_update(self, patch):
        if "name_template" in patch and template_problem(patch["name_template"]):
            patch = {k: v for k, v in patch.items() if k != "name_template"}
        for k, v in patch.items():
            if k in DEFAULTS and k != "queue":
                self.settings[k] = v
        if "mode" in patch:
            self.engine.set_mode(self.settings["mode"])
            self.ai_engine.set_mode(self.settings["mode"])
        self.save()
        if {"ai_model", "ai_device"} & set(patch):
            self.emit("status", self.status())
        return self.public_settings()

    def m_settings_reset(self):
        queue = self.settings.get("queue", [])
        self.settings = dict(DEFAULTS, queue=queue)
        self.save()
        self.emit("status", self.status())
        return self.public_settings()

    def m_settings_namePreview(self, template):
        problem = template_problem(template)
        if problem:
            return {"problem": problem}
        film = clip_name(template, {"name": "Avatar", "num": "012", "time": stamp(754)})
        ep = clip_name(template, {"name": "Breaking Bad S01E02", "num": "007", "time": stamp(311),
                                  "show": "Breaking Bad", "season": "01", "episode": "02", "code": "S01E02"})
        return {"film": film + ".mp4", "episode": ep + ".mp4"}

    def m_ffmpeg_locate(self, path):
        f, p = find_ffmpeg(path)
        if not f:
            raise RuntimeError("ffprobe.exe must be in the same folder as ffmpeg.exe.")
        self.ffmpeg, self.ffprobe = f, p
        self.settings["ffmpeg"] = path
        self.save()
        threading.Thread(target=self._find_gpu, daemon=True).start()
        return self.status()

    def m_app_status(self):
        return self.status()

    def m_app_quit(self):
        for j in self.jobs:
            j.cancel.set()
        if self.ai_token:
            self.ai_token.cancel.set()
        self.engine.kill_all()
        self.ai_engine.kill_all()
        self.save()
        threading.Timer(0.2, lambda: os._exit(0)).start()
        return True

    # ------------------------------------------------------------------ queue
    def snapshot(self):
        jobs = []
        paused = not self.running
        for j in self.jobs:
            eta = ""
            made = j.done - j.done_at_start
            if j.state == "exporting" and made >= 3 and not paused and j.t_export:
                eta = fmt_left((time.time() - j.t_export) / made * (j.total - j.done))
            jobs.append({"id": j.id, "title": j.title, "subtitle": j.subtitle, "kind": j.kind, "state": j.state,
                         "progress": round(j.progress, 4), "scan": round(min(j.progress / SCAN_PART, 1), 3),
                         "done": j.done, "total": j.total, "current": clock(j.current), "eta": eta,
                         "folder": j.folder, "message": (j.message or "").splitlines()[0][:200] if j.message else ""})
        return {"jobs": jobs, "running": self.running, "finished": self.finished}

    def _add(self, jobs):
        queued = {(j.path, j.kind, j.key) for j in self.jobs if j.state != "done"}
        added = 0
        for job in jobs:
            k = (job.path, job.kind, job.key)
            if k in queued:
                continue
            queued.add(k)
            self.jobs.append(job)
            added += 1
        if added:
            self.finished = ""
            if self.settings.get("auto_start") and not self.running and self.ffmpeg:
                self.running = True
                self.engine.set_paused(False)
            self.save()
            self.emit("jobs", self.snapshot())
        return added

    def m_queue_addFilms(self, paths):
        files = collect_videos(paths)
        return {"added": self._add([Job(f, "film", subtitle="every scene") for f in files]), "found": len(files)}

    def m_queue_remove(self, id):
        for j in list(self.jobs):
            if j.id == id:
                self.engine.kill(j)
                self.jobs.remove(j)
        self.save()
        self.emit("jobs", self.snapshot())
        return True

    def m_queue_retry(self, id):
        for j in self.jobs:
            if j.id == id:
                j.reset()
        self.emit("jobs", self.snapshot())
        return True

    def m_queue_clearFinished(self):
        self.jobs = [j for j in self.jobs if j.state != "done"]
        self.save()
        self.emit("jobs", self.snapshot())
        return True

    def m_queue_toggle(self):
        if not self.running:
            if not self.ffmpeg:
                raise RuntimeError("ffmpeg was not found. Set its location in Settings.")
            if not any(j.state == "waiting" or j.active for j in self.jobs):
                return {"running": False, "nothing": True}
        self.running = not self.running
        self.finished = ""
        self.engine.set_paused(not self.running)
        self.emit("jobs", self.snapshot())
        return {"running": self.running}

    def _start_job(self, job):
        s = dict(self.settings)
        job.state = "scanning"

        def run():
            try:
                process_job(job, s, self.engine, self.ffmpeg, self.ffprobe, self.gpu)
            except Cancelled:
                job.state = "waiting"
            except Exception as e:
                log_error(f"{job.path}\n{traceback.format_exc()}")
                job.state, job.message = "error", str(e)

        threading.Thread(target=run, daemon=True).start()

    def _scheduler(self):
        last, last_states = None, {}
        while True:
            try:
                active = [j for j in self.jobs if j.active]
                waiting = [j for j in self.jobs if j.state == "waiting" and not j.cancel.is_set()]
                if self.running:
                    limit = min(max(int(self.settings.get("parallel", 1)), 1), 4)
                    while len(active) < limit and waiting:
                        job = waiting.pop(0)
                        self._start_job(job)
                        active.append(job)
                for j in self.jobs:
                    before = last_states.get(j.id)
                    if before in ("scanning", "exporting") and j.state in ("done", "error", "nocuts"):
                        self.emit("jobDone", {"title": j.title, "state": j.state, "total": j.total})
                    last_states[j.id] = j.state
                if self.running and not active and not waiting:
                    self.running = False
                    self.engine.set_paused(False)
                    done = [j for j in self.jobs if j.state == "done"]
                    self.finished = f"All finished  -  {len(done)} done"
                    folders = [j.folder for j in done if j.folder]
                    common = None
                    try:
                        common = os.path.commonpath(folders) if folders else None
                    except ValueError:
                        pass
                    self.emit("allDone", {"count": len(done), "folder": common})
                    self.save()
                want = self.running and self.settings.get("keep_awake", True)
                if want != self.awake:
                    self.awake = want
                    keep_awake(want)
                snap = self.snapshot()
                text = json.dumps(snap)
                if text != last:
                    last = text
                    self.emit("jobs", snap)
            except Exception:
                log_error("scheduler: " + traceback.format_exc())
            time.sleep(0.25)

    # ------------------------------------------------------------------ TV
    def m_tv_scan(self, paths):
        show, seasons = group_episodes(paths)
        out = []
        for season, eps in seasons.items():
            out.append({"season": season, "episodes": [
                {"path": e["path"], "episode": e["episode"], "title": e["title"] or Path(e["path"]).stem,
                 "code": episode_code(season, e["episode"])} for e in eps]})
        if self.ffprobe:
            threading.Thread(target=self._durations, args=([e["path"] for s in out for e in s["episodes"]],),
                             daemon=True).start()
        return {"show": show, "seasons": out}
    m_tv_scan.slow = True

    def _durations(self, paths):
        for p in paths:
            try:
                d = probe(self.ffprobe, p)["duration"]
            except Exception:
                d = None
            self.emit("tvDuration", {"path": p, "duration": clock(d) if d else None})

    def m_tv_queue(self, show, episodes):
        s = self.settings
        show = safe_name(show or "Show")
        root = Path(s["output_dir"] or DEFAULTS["output_dir"]) / f"{show}_scenepack"
        pick = {"count": 0 if s["tv_all"] else int(s["tv_count"]), "mode": s["tv_mode"],
                "min_len": float(s["tv_min_len"]), "skip_start": float(s["tv_skip_start"]) * 60,
                "skip_end": float(s["tv_skip_end"]) * 60}
        how = {"spread": "spread out", "longest": "longest", "random": "random"}[s["tv_mode"]]
        per = "every scene" if s["tv_all"] else f"{s['tv_count']} clips, {how}"
        jobs = []
        for e in episodes:
            season, ep = int(e["season"]), int(e["episode"])
            code = episode_code(season, ep)
            dest = root / (f"Season {season:02d}" if season else "Other") if s["tv_layout"] == "seasons" else root
            jobs.append(Job(e["path"], "episode", title=f"{show}  {code}", subtitle=per, dest=str(dest),
                            tokens={"name": f"{show} {code}", "show": show, "season": f"{season:02d}",
                                    "episode": f"{ep:02d}", "code": code}, pick=pick, key=code))
        return {"added": self._add(jobs)}

    # ------------------------------------------------------------------ AI
    def _ai_device(self):
        return ai.resolve_device(self.settings["ai_device"])

    def _clip(self):
        key, dev = self.settings["ai_model"], self._ai_device()
        if not ai.installed(key, dev):
            if dev == "gpu" and ai.installed(key, "cpu"):
                dev = "cpu"
            else:
                raise RuntimeError("The AI model isn't downloaded yet.")
        return ai.get_clip(key, dev, self.ai_engine.threads())

    def m_ai_download(self):
        if self.ai_busy:
            raise RuntimeError("AI search is busy.")
        self.ai_busy, self.ai_token = True, Token()
        try:
            key, dev = self.settings["ai_model"], self._ai_device()
            ai.download(key, dev, lambda p, t: self.emit("aiProgress", {"p": p, "text": t}), self.ai_token.cancel)
        finally:
            self.ai_busy = False
            self.emit("status", self.status())
        return True
    m_ai_download.slow = True

    def m_ai_pause(self):
        """Stop searching early and show the results found so far."""
        if self.ai_token:
            self.ai_token.stop.set()
        return True

    def m_ai_cancel(self):
        if self.ai_token:
            self.ai_engine.kill(self.ai_token)
        return True

    def m_ai_removeModel(self):
        ai.remove(self.settings["ai_model"])
        self.emit("status", self.status())
        return True

    def m_ai_clearCache(self):
        import shutil
        shutil.rmtree(CACHE_DIR, ignore_errors=True)
        self.emit("status", self.status())
        return True

    def m_ai_search(self, files, prompt):
        if self.ai_busy:
            raise RuntimeError("AI search is busy.")
        if not self.ffmpeg:
            raise RuntimeError("ffmpeg was not found. Set its location in Settings.")
        self.ai_busy, self.ai_token = True, Token()
        s = dict(self.settings)
        ai.set_background_priority(s["mode"] != "full")
        try:
            clip = self._clip()
            fps = ai.DETAIL_FPS[s["ai_detail"]]
            files = collect_videos(files)
            videos, paused = [], False
            for i, f in enumerate(files):
                if self.ai_token.stop.is_set():
                    paused = True
                    break
                name = Path(f).name
                info = probe(self.ffprobe, f)
                ck = ai.cache_key(f, s["ai_model"], fps)
                data = ai.load_cached(ck)
                if data is None:
                    def prog(p, i=i, name=name):
                        self.emit("aiProgress", {"p": (i + p) / len(files),
                                                 "text": f"Analysing {name}  ({i + 1} of {len(files)})  "
                                                         f"{p * 100:.0f}%"})
                    prog(0)
                    try:
                        data = ai.analyze_video(self.ai_engine, self.ai_token, self.ffmpeg, f, info, clip, fps, prog,
                                                hwaccel=clip.device == "gpu")
                    except RuntimeError:
                        if clip.device != "gpu" or self.ai_token.stop.is_set():
                            raise
                        data = ai.analyze_video(self.ai_engine, self.ai_token, self.ffmpeg, f, info, clip, fps, prog)
                    if data is None:  # paused before any frame of this video was analysed
                        paused = True
                        break
                    if data.get("partial"):
                        # Paused part-way: use what was analysed, but don't remember it (it isn't complete).
                        paused = True
                        info = dict(info, duration=max(float(data["times"][-1]), float(data["ftimes"][-1])) + 0.5 / fps)
                    else:
                        ai.save_cached(ck, data)
                scenes = scenes_from_scan(list(map(float, data["times"])), list(map(float, data["scores"])), info, s)
                ep = parse_episode(f)
                label = f"{ep['show']} {episode_code(ep['season'], ep['episode'])}" if ep["season"] else Path(f).stem
                if data.get("partial"):
                    label += " (part)"
                videos.append(dict(data, path=f, info=info, scenes=scenes, label=label))
                if paused:
                    break
            self.videos = videos
            self.paused_info = {"paused": paused, "searched": len(videos), "total": len(files)}
            self.query = prompt.strip()
            self.text = ai.prompt_vector(clip, self.query) if self.query else None
            return self._results()
        finally:
            self.ai_busy = False
            ai.set_background_priority(False)
            self.emit("status", self.status())
    m_ai_search.slow = True

    def m_ai_setPrompt(self, prompt):
        self.query = prompt.strip()
        self.text = ai.prompt_vector(self._clip(), self.query) if self.query else None
        return self._results()
    m_ai_setPrompt.slow = True

    def _results(self):
        refs = [r["vec"] for r in self.refs]
        out = {"videos": [{"path": v["path"], "label": v["label"]} for v in self.videos], "items": [],
               "refs": self._refs_public(), "query": self.query, "progress": getattr(self, "paused_info", {})}
        if not self.videos or (self.text is None and not refs):
            return out
        scores = ai.score(self.videos, self.text, refs or None)
        for vi, v in enumerate(self.videos):
            for (n, a, b), (m, t, _) in zip(v["scenes"], scores.get(vi, [])):
                out["items"].append({"id": f"{vi}:{n}", "vi": vi, "n": n, "a": round(a, 3), "b": round(b, 3),
                                     "match": round(m, 4), "t": round(t, 2), "start": clock(a),
                                     "len": round(b - a, 1)})
        return out

    def _refs_public(self):
        return [{"id": r["id"], "label": r["label"], "thumb": r["thumb"]} for r in self.refs]

    def m_ai_addRefImage(self, path):
        clip = self._clip()
        vec = ai.image_vector(clip, self.ffmpeg, path)
        self.refs.append({"id": hashlib.sha1(f"{path}{time.time()}".encode()).hexdigest()[:10], "label": Path(path).stem,
                          "vec": vec, "thumb": ai.image_thumbnail(self.ffmpeg, path)})
        return self._results()
    m_ai_addRefImage.slow = True

    def m_ai_addRefScene(self, vi, t):
        import numpy as np
        v = self.videos[vi]
        idx = int(np.abs(v["ftimes"] - t).argmin())
        vec = v["emb"][idx].astype("float32")
        vec = vec / max(float(np.linalg.norm(vec)), 1e-8)
        self.refs.append({"id": f"s{vi}-{idx}", "label": f"{v['label']} {clock(t)}", "vec": vec,
                          "thumb": ai.thumbnail(self.ffmpeg, v["path"], t)})
        return self._results()
    m_ai_addRefScene.slow = True

    def m_ai_removeRef(self, id):
        self.refs = [r for r in self.refs if r["id"] != id]
        return self._results()

    def m_ai_thumb(self, vi, t):
        with self.thumb_lock:
            return ai.thumbnail(self.ffmpeg, self.videos[vi]["path"], t)
    m_ai_thumb.slow = True

    def m_ai_queue(self, pack, items):
        s = self.settings
        pack = safe_name(pack or self.query or "AI search")
        dest = Path(s["output_dir"] or DEFAULTS["output_dir"]) / f"{pack}_scenepack"
        jobs = []
        for vi, v in enumerate(self.videos):
            picked = sorted(([i["n"], i["a"], i["b"]] for i in items if i["vi"] == vi), key=lambda x: x[1])
            if not picked:
                continue
            stem = safe_name(Path(v["path"]).stem)
            ep = parse_episode(v["path"])
            tokens = {"name": stem}
            if ep["season"]:
                code = episode_code(ep["season"], ep["episode"])
                tokens = {"name": f"{safe_name(ep['show'])} {code}", "show": safe_name(ep["show"]),
                          "season": f"{ep['season']:02d}", "episode": f"{ep['episode']:02d}", "code": code}
            key = f"{stem}-{hashlib.sha1(pack.encode()).hexdigest()[:8]}-{hashlib.sha1(json.dumps(picked).encode()).hexdigest()[:6]}"
            jobs.append(Job(v["path"], "ai", title=tokens["name"], subtitle=f"{len(picked)} scenes for \"{pack}\"",
                            dest=str(dest), tokens=tokens, preset=picked, key=key))
        return {"added": self._add(jobs)}

    # ------------------------------------------------------------------ Library
    def _library_roots(self):
        roots = [self.settings["output_dir"] or DEFAULTS["output_dir"]] + list(self.settings.get("library_dirs") or [])
        out = []
        for r in roots:
            if r and os.path.normcase(r) not in {os.path.normcase(x) for x in out}:
                out.append(r)
        return out

    def m_library_scan(self):
        return {"roots": self._library_roots(), "groups": library.scan(self._library_roots())}
    m_library_scan.slow = True

    def m_library_meta(self, paths):
        if not self.ffprobe:
            return {}
        return {p: library.meta(self.ffprobe, p) for p in paths}
    m_library_meta.slow = True

    def m_library_thumb(self, path, duration=0):
        if not self.ffmpeg:
            return None
        t = min(1.0, max(float(duration or 0) * 0.4, 0))
        return ai.thumbnail(self.ffmpeg, path, t)
    m_library_thumb.slow = True

    def m_library_addRoot(self, path):
        dirs = list(self.settings.get("library_dirs") or [])
        if path not in dirs:
            dirs.append(path)
        self.settings["library_dirs"] = dirs
        self.save()
        return self.m_library_scan()
    m_library_addRoot.slow = True

    def m_library_removeRoot(self, path):
        self.settings["library_dirs"] = [d for d in self.settings.get("library_dirs") or [] if d != path]
        self.save()
        return self.m_library_scan()
    m_library_removeRoot.slow = True

    def m_library_export(self, items, dest, mode="copy", subfolders=False):
        self.export_cancel = threading.Event()
        return library.export(items, dest, mode, subfolders, cancel=self.export_cancel,
                              progress=lambda i, n, name: self.emit("libraryProgress", {"done": i, "total": n, "name": name}))
    m_library_export.slow = True

    def m_library_cancelExport(self):
        if getattr(self, "export_cancel", None):
            self.export_cancel.set()
        return True

    def m_preview(self, vi, a, b):
        v = self.videos[vi]
        player = Path(self.ffmpeg).with_name("ffplay.exe")
        if not player.is_file():
            import shutil
            found = shutil.which("ffplay") or next((str(p) for p in Path(os.environ.get("LOCALAPPDATA", ".")).glob(
                "Microsoft/WinGet/Packages/*FFmpeg*/*/bin/ffplay.exe")), None)
            player = Path(found) if found else player
        if not player.is_file():
            raise RuntimeError("Previews need ffplay.exe (part of FFmpeg). Install it with: winget install Gyan.FFmpeg")
        subprocess.Popen([str(player), "-hide_banner", "-loglevel", "quiet", "-autoexit", "-ss", f"{a:.3f}", "-t",
                          f"{b - a:.3f}", "-x", "960", "-y", "540", "-window_title",
                          f"{Path(v['path']).stem}  {clock(a)}", v["path"]], creationflags=NO_WINDOW,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True


def keep_awake(on):
    try:
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | (0x1 if on else 0))
    except Exception:
        pass


def main():
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    out = open(sys.stdout.fileno(), "w", encoding="utf-8", buffering=1, closefd=False)
    sys.stdout = sys.stderr  # stray prints must never corrupt the message stream
    server = Server(out)
    server.emit("ready", {"version": VERSION})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        server.handle(msg)
    server.m_app_quit()  # the app closed our input: tidy up and exit
    time.sleep(0.5)


if __name__ == "__main__":
    main()
