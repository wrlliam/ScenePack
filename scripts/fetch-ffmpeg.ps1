# Downloads a small "shared" GPL build of FFmpeg (ffmpeg, ffprobe, ffplay + shared libraries) into vendor/ffmpeg,
# which the installer ships so ScenePack works straight away. Builds come from github.com/BtbN/FFmpeg-Builds.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $root 'vendor\ffmpeg'
if (Test-Path (Join-Path $dest 'ffmpeg.exe')) { Write-Host "vendor/ffmpeg already present"; exit 0 }

$headers = @{ 'User-Agent' = 'ScenePack-build' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
$release = Invoke-RestMethod 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest' -Headers $headers
# newest numbered release branch (not "master"), 64-bit Windows, GPL (needed for libx264), shared libraries
$asset = $release.assets | Where-Object { $_.name -match '^ffmpeg-n(\d+\.\d+).*-win64-gpl-shared-[\d.]+\.zip$' } |
    Sort-Object { [version]([regex]::Match($_.name, 'n(\d+\.\d+)').Groups[1].Value) } -Descending | Select-Object -First 1
if (-not $asset) { throw "No suitable FFmpeg build found in the latest BtbN release." }
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ffmpeg-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$zip = Join-Path $tmp 'ffmpeg.zip'
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -Headers @{ 'User-Agent' = 'ScenePack-build' } -UseBasicParsing
Expand-Archive $zip -DestinationPath $tmp
$top = Get-ChildItem $tmp -Directory | Select-Object -First 1
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $top.FullName 'bin\*') $dest
Copy-Item (Join-Path $top.FullName 'LICENSE.txt') (Join-Path $dest 'LICENSE.txt') -ErrorAction SilentlyContinue
Set-Content (Join-Path $dest 'SOURCE.txt') "FFmpeg build: $($asset.name)`nFrom: https://github.com/BtbN/FFmpeg-Builds/releases/tag/$($release.tag_name)`nFFmpeg source code: https://ffmpeg.org/download.html`nThis build is licensed under the GNU GPL; see LICENSE.txt." -Encoding utf8
Remove-Item -Recurse -Force $tmp
Write-Host "FFmpeg ready in vendor/ffmpeg ($([math]::Round((Get-ChildItem $dest | Measure-Object Length -Sum).Sum / 1MB)) MB)"
