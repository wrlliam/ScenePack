# Builds release/ScenePack-Setup-<version>.exe on your own PC (the GitHub workflow does the same thing).
# Needs: Python 3.10+, Node.js 20+.  Run from the project folder:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "`n1/4  Python packages" -ForegroundColor Cyan
python -m pip install --disable-pip-version-check -q -r requirements.txt -r requirements-dev.txt

Write-Host "2/4  Backend (PyInstaller)" -ForegroundColor Cyan
python -m PyInstaller --noconfirm --clean --log-level WARN scenepack-backend.spec

Write-Host "3/4  FFmpeg" -ForegroundColor Cyan
if (-not (Test-Path vendor\ffmpeg\ffmpeg.exe)) {
    try {
        & .\scripts\fetch-ffmpeg.ps1
    } catch {
        # offline fallback: reuse an FFmpeg already installed with winget
        $bin = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*FFmpeg*\*\bin" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $bin) { throw "Couldn't get FFmpeg. Install it with 'winget install Gyan.FFmpeg' and run this again." }
        New-Item -ItemType Directory -Force vendor\ffmpeg | Out-Null
        Copy-Item "$($bin.FullName)\ffmpeg.exe", "$($bin.FullName)\ffprobe.exe" vendor\ffmpeg
        Copy-Item (Join-Path (Split-Path $bin.FullName) 'LICENSE') vendor\ffmpeg\LICENSE.txt -ErrorAction SilentlyContinue
    }
}

Write-Host "4/4  Installer (electron-builder)" -ForegroundColor Cyan
if (-not (Test-Path node_modules)) { npm ci }
if (-not (Test-Path node_modules\electron\dist\electron.exe)) { node node_modules\electron\install.js }
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run dist
Get-ChildItem release\ScenePack-Setup-*.exe | ForEach-Object { Write-Host "`nDone: $($_.FullName)  ($([math]::Round($_.Length / 1MB)) MB)" -ForegroundColor Green }
Write-Host "Tip: if the build fails with a 'could not find' error, the folder path is too long for Windows. Move the project somewhere shorter, e.g. C:\dev\ScenePack."
