"""Recognising TV episodes from file and folder names."""

import os
import re
from pathlib import Path

from .config import VIDEO_EXT

_PATTERNS = [
    re.compile(r"(?<![a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?!\d)", re.I),           # S01E02, s1.e2
    re.compile(r"(?<!\d)(\d{1,2})x(\d{2,3})(?!\d)", re.I),                           # 1x02
    re.compile(r"season[ ._-]*(\d{1,2})[ ._-]*(?:episode|ep|e)[ ._-]*(\d{1,3})", re.I),
]
_SEASON_DIR = re.compile(r"^(?:season|series|s)[ ._-]*(\d{1,2})$", re.I)
_EP_ONLY = [re.compile(r"(?:episode|ep|e)[ ._-]*(\d{1,3})(?!\d)", re.I), re.compile(r"^(\d{1,3})(?!\d)")]
_JUNK = re.compile(r"\b(1080p|2160p|720p|480p|4k|x264|x265|h\.?264|h\.?265|hevc|web[- .]?dl|webrip|bluray|"
                   r"brrip|hdtv|dvdrip|proper|repack|aac|ddp?5\.1|10bit)\b.*$", re.I)


def _clean(text):
    text = re.sub(r"[._]+", " ", text)
    text = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", text)
    text = _JUNK.sub("", text)
    return re.sub(r"\s{2,}", " ", text).strip(" -_")


def parse_episode(path):
    """Return {path, show, season, episode, title} - season/episode are ints or None."""
    p = Path(path)
    stem = p.stem
    show, season, episode, title = "", None, None, ""
    for pat in _PATTERNS:
        m = pat.search(stem)
        if m:
            season, episode = int(m.group(1)), int(m.group(2))
            show = _clean(stem[:m.start()])
            title = _clean(stem[m.end():])
            break
    parent = p.parent.name
    if season is None:
        m = _SEASON_DIR.match(parent.strip())
        if m:
            season = int(m.group(1))
            for pat in _EP_ONLY:
                e = pat.search(stem)
                if e:
                    episode = int(e.group(1))
                    title = _clean(stem[e.end():])
                    break
    if not show:
        folder = p.parent
        if _SEASON_DIR.match(folder.name.strip()):
            folder = folder.parent
        show = _clean(folder.name) or "Show"
    return {"path": str(p), "show": show, "season": season, "episode": episode, "title": title}


def collect_videos(paths):
    """Expand files and folders (recursively) into a sorted list of video files."""
    out = []
    for p in paths:
        p = os.path.normpath(p)
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                out += [os.path.join(root, f) for f in files if Path(f).suffix.lower() in VIDEO_EXT]
        elif os.path.isfile(p) and Path(p).suffix.lower() in VIDEO_EXT:
            out.append(p)
    seen, unique = set(), []
    for f in out:
        if f.lower() not in seen:
            seen.add(f.lower())
            unique.append(f)
    return unique


def group_episodes(paths):
    """Parse many files -> (show name, {season: [episode dicts sorted]}). Unknown seasons go under 0."""
    eps = [parse_episode(f) for f in collect_videos(paths)]
    seasons = {}
    for e in eps:
        seasons.setdefault(e["season"] or 0, []).append(e)
    for s, lst in seasons.items():
        lst.sort(key=lambda e: (e["episode"] is None, e["episode"] or 0, e["path"].lower()))
        if s == 0:  # number unknown episodes in name order
            for i, e in enumerate(lst, 1):
                e["episode"] = e["episode"] or i
    names = [e["show"] for e in eps if e["show"]]
    show = max(set(names), key=names.count) if names else "Show"
    return show, dict(sorted(seasons.items()))


def episode_code(season, episode):
    return f"S{season:02d}E{episode:02d}" if season else f"E{episode:02d}"
