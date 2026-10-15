# Builds the no-install ("portable") Windows package: an unzip-and-run folder with
# a portable.txt marker that makes the app keep its settings inside the folder too
# (see portable_user_data_dir in src-tauri/src/lib.rs).
#
# Run from the repository root after a normal Windows build:
#   pwsh -File scripts/portable-win.ps1
# Needs the same hand-placed Windows binaries a local install build needs
# (adb.exe and its two DLLs under src-tauri/bin).
param(
    [string]$Version = "",
    [string]$TargetDir = "src-tauri/target/release",
    [string]$OutDir = "src-tauri/target/release/bundle/portable"
)
$ErrorActionPreference = "Stop"

if (-not $Version) {
    $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
}

$exe = Join-Path $TargetDir "tauri-app.exe"
if (-not (Test-Path $exe)) {
    Write-Error "no $exe - run the Windows build first (npm run tauri build -- --bundles nsis --config src-tauri/tauri.windows-gnu.json)"
}

$stage = Join-Path $OutDir "SocketSweepAtlas-$Version-portable"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $stage "bin"), $OutDir | Out-Null

Copy-Item $exe (Join-Path $stage "tauri-app.exe")
foreach ($name in @("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll")) {
    $src = Join-Path "src-tauri/bin" $name
    if (-not (Test-Path $src)) { Write-Error "missing $src - see the build notes"; }
    Copy-Item $src (Join-Path $stage "bin\$name")
}
Copy-Item "src-tauri/bin/daemon" (Join-Path $stage "bin\daemon")

# Only the GNU toolchain links the loader dynamically; an MSVC build (CI) carries
# the static one, so shipping the DLL there would be dead weight at best.
$loader = "src-tauri/webview2/WebView2Loader.dll"
if (Test-Path $loader) {
    Copy-Item $loader (Join-Path $stage "WebView2Loader.dll")
    Write-Host "including WebView2Loader.dll (GNU build)"
} else {
    Write-Host "no WebView2Loader.dll to copy - assuming an MSVC build"
}

# The switch itself. Written as prose because a user who finds this file in the
# folder should be able to tell what deleting it would do.
$marker = @"
SocketSweepAtlas portable build.

While this file sits next to tauri-app.exe, the app keeps its settings and its
temporary files inside this folder instead of in your Windows profile, so the
folder can be copied to another PC or a USB stick and take its settings with it.
Delete this file to go back to the default location.

SocketSweepAtlas 便携版说明：只要这个文件和 tauri-app.exe 放在同一个目录，
程序就会把设置和临时文件保存在这个目录里（而不是 Windows 用户目录），
整个文件夹可以拷到别的电脑或 U 盘上，设置跟着走。删掉这个文件就恢复默认位置。
"@
Set-Content -Path (Join-Path $stage "portable.txt") -Value $marker -Encoding UTF8

$zip = Join-Path $OutDir "SocketSweepAtlas-$Version-portable.zip"
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force

$bytes = (Get-Item $zip).Length
Write-Host ("portable package: " + $zip)
Write-Host ("files in folder: " + ((Get-ChildItem -Recurse $stage | Where-Object { -not $_.PSIsContainer }).Count))
Write-Host ("bytes: " + $bytes)
