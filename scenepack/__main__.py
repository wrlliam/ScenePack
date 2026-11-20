"""Start ScenePack:  python -m scenepack [videos...] [--start] [--page=queue|tv|ai|settings|about]"""

import sys


def main():
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # crisp text on high-DPI screens
        except Exception:
            pass
    from .ui.app import App
    args = sys.argv[1:]
    files = [a for a in args if not a.startswith("--")]
    page = next((a.split("=", 1)[1] for a in args if a.startswith("--page=")), "queue")
    if page not in ("queue", "tv", "ai", "settings", "about"):
        page = "queue"
    App(files=files, autostart="--start" in args, page=page).mainloop()


if __name__ == "__main__":
    main()
