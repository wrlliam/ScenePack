"""AI scene search with CLIP, running locally through ONNX Runtime.

CLIP turns pictures and text into vectors that point the same way when they mean the same thing.
ScenePack samples frames from each video, turns them into vectors once (cached on disk), and then any
prompt or reference picture can be compared against every scene instantly.
"""

import hashlib
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from .config import CACHE_DIR, MODEL_DIR, log_error
from .engine import NO_WINDOW, Cancelled, parse_scores

MODELS = {
    "fast": {"label": "Fast model (CLIP ViT-B/32)", "repo": "Xenova/clip-vit-base-patch32",
             "size": {"cpu": 155, "gpu": 292}},
    "accurate": {"label": "Accurate model (CLIP ViT-B/16)", "repo": "Xenova/clip-vit-base-patch16",
                 "size": {"cpu": 147, "gpu": 288}},
}
# Small int8 files run fastest on the processor; half-precision files run fastest on a graphics card.
VARIANTS = {"cpu": ["tokenizer.json", "onnx/text_model_quantized.onnx", "onnx/vision_model_quantized.onnx"],
            "gpu": ["tokenizer.json", "onnx/text_model_fp16.onnx", "onnx/vision_model_fp16.onnx"]}
DETAIL_FPS = {"fast": 0.5, "normal": 1.0, "detailed": 2.0}
SIZE = 224
MEAN = (0.48145466, 0.4578275, 0.40821073)
STD = (0.26862954, 0.26130258, 0.27577711)
BASELINES = ["a still from a film", "a frame from a movie", "a scene from a tv show", "a photo"]


def available():
    try:
        import numpy  # noqa: F401
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
        return True
    except Exception:
        return False


def gpu_available():
    """True when ONNX Runtime can use the graphics card (DirectML: AMD, NVIDIA and Intel on Windows)."""
    try:
        import onnxruntime as ort
        return "DmlExecutionProvider" in ort.get_available_providers() or \
            "CUDAExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def resolve_device(setting):
    if setting == "cpu":
        return "cpu"
    return "gpu" if gpu_available() else "cpu"


def model_dir(key):
    return MODEL_DIR / key


def installed(key, device="cpu"):
    return all((model_dir(key) / f).is_file() for f in VARIANTS[device])


def remove(key):
    shutil.rmtree(model_dir(key), ignore_errors=True)
    for k in [k for k in _SESSIONS if k[0] == key]:
        _SESSIONS.pop(k, None)


def download(key, device, progress, cancel):
    """Download the model from Hugging Face. progress(fraction, text)."""
    repo = MODELS[key]["repo"]
    base = model_dir(key)
    total = MODELS[key]["size"][device] * 1_000_000
    done = 0
    for name in VARIANTS[device]:
        dst = base / name
        if dst.is_file():
            done += dst.stat().st_size
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + ".part")
        req = urllib.request.Request(f"https://huggingface.co/{repo}/resolve/main/{name}",
                                     headers={"User-Agent": "ScenePack"})
        with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
            while True:
                if cancel.is_set():
                    f.close()
                    tmp.unlink(missing_ok=True)
                    raise Cancelled()
                chunk = r.read(1 << 18)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                progress(min(done / total, 1.0), f"Downloading the AI model  {done / 1e6:.0f} of {total / 1e6:.0f} MB")
        os.replace(tmp, dst)
    progress(1.0, "AI model ready")


# --------------------------------------------------------------------------- model

_SESSIONS = {}


class Clip:
    def __init__(self, key, device="cpu", threads=0):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.np, self.device = np, device
        files = VARIANTS[device]
        d = model_dir(key)
        so = ort.SessionOptions()
        so.log_severity_level = 3
        if device == "gpu":
            have = ort.get_available_providers()
            providers = [p for p in ("DmlExecutionProvider", "CUDAExecutionProvider") if p in have][:1]
            providers.append("CPUExecutionProvider")
            so.enable_mem_pattern = False  # required by DirectML
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        else:
            providers = ["CPUExecutionProvider"]
            if threads:
                so.intra_op_num_threads = threads
        self.vision = ort.InferenceSession(str(d / files[2]), so, providers=providers)
        self.text = ort.InferenceSession(str(d / files[1]), so, providers=providers)
        self.tok = Tokenizer.from_file(str(d / files[0]))
        self.v_in = self.vision.get_inputs()[0]
        self.v_half = "float16" in self.v_in.type
        self.t_in = [i.name for i in self.text.get_inputs()]
        self.v_out = self._pick_output(self.vision, "image_embeds")
        self.t_out = self._pick_output(self.text, "text_embeds")
        self.mean = np.array(MEAN, dtype=np.float32).reshape(1, 3, 1, 1)
        self.std = np.array(STD, dtype=np.float32).reshape(1, 3, 1, 1)
        self.batch = 32 if device == "gpu" else 16

    @staticmethod
    def _pick_output(sess, want):
        names = [o.name for o in sess.get_outputs()]
        return want if want in names else names[0]

    def _norm(self, x):
        x = x.astype(self.np.float32)
        return x / self.np.maximum(self.np.linalg.norm(x, axis=1, keepdims=True), 1e-8)

    def images(self, rgb):
        """rgb: uint8 array (N, 224, 224, 3) -> unit vectors (N, D)."""
        np = self.np
        x = rgb.astype(np.float32).transpose(0, 3, 1, 2) / 255.0
        x = (x - self.mean) / self.std
        if self.v_half:
            x = x.astype(np.float16)
        return self._norm(self.vision.run([self.v_out], {self.v_in.name: x})[0])

    def texts(self, texts):
        np = self.np
        enc = [self.tok.encode(t).ids[:77] for t in texts]
        ids = np.full((len(enc), 77), 49407, dtype=np.int64)
        mask = np.zeros((len(enc), 77), dtype=np.int64)
        for i, e in enumerate(enc):
            if e and e[-1] != 49407:
                e = e[:76] + [49407]
            ids[i, :len(e)] = e
            mask[i, :len(e)] = 1
        feed = {name: (mask if "mask" in name else ids) for name in self.t_in}
        return self._norm(self.text.run([self.t_out], feed)[0])


def get_clip(key, device="cpu", threads=0):
    """Load (once) the model on the chosen device. Falls back to the processor if the graphics card fails."""
    if (key, device) not in _SESSIONS:
        try:
            clip = Clip(key, device, threads)
            clip.images(__import__("numpy").zeros((1, SIZE, SIZE, 3), "uint8"))  # warm up / prove it works
        except Exception as e:
            if device != "gpu" or not installed(key, "cpu"):
                raise
            log_error(f"AI on graphics card failed, using the processor: {e!r}")
            return get_clip(key, "cpu", threads)
        _SESSIONS[(key, device)] = clip
    return _SESSIONS[(key, device)]

def prompt_vector(clip, prompt):
    """Average a few phrasings of the prompt - CLIP is steadier that way."""
    np = clip.np
    p = prompt.strip().rstrip(".")
    v = clip.texts([p, f"a still from a film showing {p}", f"a photo of {p}"]).mean(axis=0)
    base = clip.texts(BASELINES).mean(axis=0)
    return v / np.linalg.norm(v), base / np.linalg.norm(base)


# --------------------------------------------------------------------------- analysing videos

def cache_key(path, model, fps):
    st = os.stat(path)
    raw = f"{os.path.abspath(path).lower()}|{st.st_size}|{int(st.st_mtime)}|{model}|{fps}|v1"
    return hashlib.sha1(raw.encode()).hexdigest()


def load_cached(key):
    import numpy as np
    f = CACHE_DIR / f"{key}.npz"
    if not f.is_file():
        return None
    try:
        d = np.load(f)
        return {k: d[k] for k in ("times", "scores", "ftimes", "emb")}
    except Exception:
        return None


def save_cached(key, data):
    import numpy as np
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_DIR / f"{key}.tmp.npz"
    np.savez(tmp, times=data["times"], scores=data["scores"], ftimes=data["ftimes"],
             emb=data["emb"].astype(np.float16))
    os.replace(tmp, CACHE_DIR / f"{key}.npz")


def analyze_video(engine, token, ffmpeg, path, info, clip, fps, progress, hwaccel=False):
    """One pass over the video: scene-change scores for cutting, and CLIP vectors for sampled frames."""
    import numpy as np
    th = engine.threads()
    work = tempfile.mkdtemp(prefix="scenepack_")
    fc = ("[0:v]split=2[a][b];"
          "[a]scale=320:-2:flags=fast_bilinear,select='gte(scene,0)',metadata=print:file=scan.txt[s];"
          f"[b]fps={fps},scale={SIZE}:{SIZE}:force_original_aspect_ratio=increase:flags=bilinear,"
          f"crop={SIZE}:{SIZE},format=rgb24[f]")
    # stdin is a private pipe (never the app's message channel) so a pause can ask ffmpeg to quit politely
    # with "q": it then finishes writing its scene-cut notes instead of losing the last chunk.
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostats"] + (["-threads", str(th)] if th else []) + \
          (["-hwaccel", "auto"] if hwaccel else []) + ["-i", path, "-filter_complex", fc, "-map", "[s]", "-f", "null", "-",
           "-map", "[f]", "-f", "rawvideo", "pipe:1"]
    frame_bytes = SIZE * SIZE * 3
    expected = max(info["duration"] * fps, 1)
    embs, err = [], []
    proc = engine.popen(cmd, token, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=work)
    reader = threading.Thread(target=lambda: err.extend(proc.stderr.read().decode("utf-8", "replace")
                                                        .splitlines()[-6:]), daemon=True)
    reader.start()
    partial = False
    stop = getattr(token, "stop", None)
    try:
        batch, count = [], 0
        while True:
            if token.cancel.is_set():
                proc.kill()
                raise Cancelled()
            if stop is not None and stop.is_set() and not partial:
                # Paused: ask ffmpeg to wrap up, then keep reading until it has flushed and closed.
                partial = True
                try:
                    proc.stdin.write(b"q")
                    proc.stdin.flush()
                except OSError:
                    proc.kill()
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            if partial:
                continue  # frames still draining out of ffmpeg after the pause: not needed
            batch.append(np.frombuffer(buf, np.uint8).reshape(SIZE, SIZE, 3))
            count += 1
            if len(batch) == clip.batch:
                engine.wait_if_paused(token)
                embs.append(clip.images(np.stack(batch)))
                batch = []
                progress(min(count / expected, 1.0))
        if batch:
            embs.append(clip.images(np.stack(batch)))
        proc.wait()
        reader.join(timeout=5)
        if token.cancel.is_set():
            raise Cancelled()
        if not embs:
            if partial:
                return None
            raise RuntimeError("This video could not be analysed.\n" + "\n".join(err).strip())
        if proc.returncode != 0 and not partial:
            raise RuntimeError("This video could not be analysed.\n" + "\n".join(err).strip())
        with open(os.path.join(work, "scan.txt"), encoding="utf-8", errors="replace") as f:
            times, scores = parse_scores(f)
    finally:
        engine.release(proc, token)
        shutil.rmtree(work, ignore_errors=True)
    emb = np.concatenate(embs)
    ftimes = (np.arange(len(emb)) + 0.5) / fps
    if partial:
        # ffmpeg was stopped, so the tail of its scene-cut notes may be missing (they're written in chunks).
        # Keep only the stretch covered by both the cut notes and the analysed frames.
        end = min(float(ftimes[-1]) + 0.5 / fps, float(times[-1]) if times else 0.0)
        if end <= 0:
            return None
        keep = [i for i, t in enumerate(times) if t <= end]
        times, scores = [times[i] for i in keep], [scores[i] for i in keep]
        n = int(np.searchsorted(ftimes, end, side="right"))
        if n == 0:
            return None
        emb, ftimes = emb[:n], ftimes[:n]
    return {"times": np.array(times, np.float32), "scores": np.array(scores, np.float32),
            "ftimes": ftimes.astype(np.float32), "emb": emb, "partial": partial}


def image_vector(clip, ffmpeg, path):
    """Load a reference picture (any format ffmpeg reads) and turn it into a CLIP vector."""
    import numpy as np
    r = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf",
                        f"scale={SIZE}:{SIZE}:force_original_aspect_ratio=increase,crop={SIZE}:{SIZE},format=rgb24",
                        "-f", "rawvideo", "pipe:1"], capture_output=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW, timeout=60)
    if r.returncode != 0 or len(r.stdout) < SIZE * SIZE * 3:
        raise RuntimeError("That picture could not be read.")
    rgb = np.frombuffer(r.stdout[:SIZE * SIZE * 3], np.uint8).reshape(1, SIZE, SIZE, 3)
    return clip.images(rgb)[0]


# --------------------------------------------------------------------------- scoring

def _calibrate(np, raw, absolute):
    """Blend 'how good is this compared to the rest' with 'how good is this on its own' into 0..1."""
    med = float(np.median(raw))
    top = float(raw.max())
    rel = np.clip((raw - med) / max(top - med, 1e-3), 0, 1)
    return 0.6 * rel + 0.4 * absolute


def score(videos, text=None, refs=None):
    """videos: list of dicts with scenes [[n,a,b]], ftimes, emb.
    Returns {video index: [(match 0..1, best frame time, frame index), ...] per scene}."""
    import numpy as np
    per_scene = []  # (video i, scene j, text raw, ref raw, best frame idx)
    for vi, v in enumerate(videos):
        emb, ft = v["emb"].astype(np.float32), v["ftimes"]
        t_raw = emb @ text[0] - emb @ text[1] if text is not None else None
        r_raw = (emb @ np.stack(refs).T).max(axis=1) if refs else None
        frame = (t_raw if t_raw is not None else 0) + (r_raw if r_raw is not None else 0)
        for sj, (n, a, b) in enumerate(v["scenes"]):
            idx = np.nonzero((ft >= a) & (ft < b))[0]
            if len(idx) == 0:
                idx = np.array([int(np.argmin(np.abs(ft - (a + b) / 2)))])
            best = idx[int(np.argmax(frame[idx]))] if np.ndim(frame) else int(idx[0])
            # score a scene by its best frame, nudged by how consistently it matches
            tr = float(t_raw[idx].max() * 0.75 + t_raw[idx].mean() * 0.25) if t_raw is not None else 0.0
            rr = float(r_raw[idx].max() * 0.75 + r_raw[idx].mean() * 0.25) if r_raw is not None else 0.0
            per_scene.append((vi, sj, tr, rr, int(best)))
    if not per_scene:
        return {}
    parts = []
    if text is not None:
        raw = np.array([p[2] for p in per_scene])
        parts.append(_calibrate(np, raw, 1 / (1 + np.exp(-(raw * 100 - 1.0)))))
    if refs:
        raw = np.array([p[3] for p in per_scene])
        parts.append(_calibrate(np, raw, np.clip((raw - 0.6) / 0.3, 0, 1)))
    match = sum(parts) / len(parts)
    out = {}
    for (vi, sj, _, _, best), m in zip(per_scene, match):
        v = videos[vi]
        out.setdefault(vi, [None] * len(v["scenes"]))[sj] = (float(m), float(v["ftimes"][best]), best)
    return out


def thumbnail(ffmpeg, path, t, width=320):
    """Path to a JPEG of the frame at time t (cached)."""
    key = hashlib.sha1(f"{os.path.abspath(path)}|{t:.2f}|{width}".encode()).hexdigest()
    f = CACHE_DIR / "thumbs" / f"{key}.jpg"
    if f.is_file():
        return str(f)
    f.parent.mkdir(parents=True, exist_ok=True)
    h = width * 9 // 16
    r = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{max(t, 0):.3f}", "-i", path,
                        "-frames:v", "1", "-vf", f"scale={width}:{h}:force_original_aspect_ratio=increase,"
                        f"crop={width}:{h}", "-q:v", "4", str(f)],
                       capture_output=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW, timeout=60)
    return str(f) if r.returncode == 0 and f.is_file() else None


def image_thumbnail(ffmpeg, path, width=160):
    key = hashlib.sha1(f"img|{os.path.abspath(path)}|{width}".encode()).hexdigest()
    f = CACHE_DIR / "thumbs" / f"{key}.jpg"
    if not f.is_file():
        f.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-frames:v", "1", "-vf",
                        f"scale={width}:{width}:force_original_aspect_ratio=increase,crop={width}:{width}",
                        "-q:v", "4", str(f)], capture_output=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW, timeout=60)
    return str(f) if f.is_file() else None

def set_background_priority(on):
    """Lower ScenePack's own priority while the model runs, so other apps stay smooth."""
    try:
        import ctypes
        cls = 0x00004000 if on else 0x00000020  # below normal / normal
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), cls)
    except Exception:
        pass
