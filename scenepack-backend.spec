# PyInstaller recipe for the Python backend.  Build with:  pyinstaller --noconfirm --clean scenepack-backend.spec
# Output: dist/scenepack-backend/scenepack-backend.exe (+ its libraries), which electron-builder ships as resources/backend.
from PyInstaller.utils.hooks import collect_dynamic_libs

binaries = collect_dynamic_libs("onnxruntime")          # includes DirectML.dll for graphics-card AI
hidden = ["onnxruntime", "onnxruntime.capi._pybind_state", "tokenizers", "numpy"]

a = Analysis(
    ["backend_main.py"],
    pathex=["."],
    binaries=binaries,
    datas=[],
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "PIL", "pytest", "IPython", "sympy", "mpmath", "onnxruntime.transformers",
              "onnxruntime.quantization", "onnxruntime.tools", "onnx", "torch"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="scenepack-backend",
    console=True,          # talks over stdin/stdout; Electron starts it with the window hidden
    icon="assets/icon.ico",
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="scenepack-backend", upx=False)
