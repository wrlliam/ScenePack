"""Entry point PyInstaller uses to build scenepack-backend.exe (the Electron app starts it)."""
from scenepack.server import main

if __name__ == "__main__":
    main()
