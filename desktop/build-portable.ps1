# Builds a portable PhotoServer: a self-contained folder with PhotoServer.exe
# you double-click. No install, no admin. Output: desktop/dist/PhotoServer/
#
# Usage:  npm run package      (from the desktop folder)

$ErrorActionPreference = "Stop"
$desktop = $PSScriptRoot
$root = Split-Path $desktop -Parent          # repo root (has server/ + desktop/)
$dist = Join-Path $desktop "dist\PhotoServer"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

Write-Host "Building portable PhotoServer..." -ForegroundColor Cyan

# 1. Fresh dist folder
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force $dist | Out-Null

# 2. Make sure icons exist
node (Join-Path $desktop "assets\generate-icons.js") | Out-Null

# 3. Compile the launcher -> PhotoServer.exe (windowed, with our icon)
$exePath = Join-Path $dist "PhotoServer.exe"
$iconPath = Join-Path $desktop "assets\app.ico"
$srcPath = Join-Path $desktop "packaging\launcher.cs"
& $csc /nologo /target:winexe "/out:$exePath" "/win32icon:$iconPath" `
    /reference:System.Windows.Forms.dll "$srcPath"
if (-not (Test-Path $exePath)) { throw "launcher compile failed" }

# 4. Bundle the Node runtime
Copy-Item (Get-Command node).Source (Join-Path $dist "node.exe")

# 5. Copy the app (server is zero-dependency; desktop carries node_modules)
$serverDst = Join-Path $dist "server\src"
New-Item -ItemType Directory -Force $serverDst | Out-Null
Copy-Item (Join-Path $root "server\src\*") $serverDst -Recurse
Copy-Item (Join-Path $root "server\package.json") (Join-Path $dist "server\package.json")

$deskDst = Join-Path $dist "desktop"
foreach ($sub in @("src", "public", "assets")) {
    $d = Join-Path $deskDst $sub
    New-Item -ItemType Directory -Force $d | Out-Null
    Copy-Item (Join-Path $desktop "$sub\*") $d -Recurse
}
Copy-Item (Join-Path $desktop "package.json") (Join-Path $deskDst "package.json")

# node_modules (sharp, systray2 + helper exe, node-notifier + helper)
Write-Host "Copying node_modules (this is the big part)..." -ForegroundColor DarkGray
$nodeModulesDst = Join-Path $deskDst "node_modules"
Copy-Item (Join-Path $desktop "node_modules") $nodeModulesDst -Recurse

# 5b. Drop platform binaries this Windows build can never use. systray2 and
# node-notifier ship helper binaries for macOS and Linux alongside the Windows
# ones; only the Windows ones run here. Pruned from the dist copy only — the
# dev node_modules is left intact. (sharp is already Windows-only via npm.)
$prune = @(
    "systray2\traybin\tray_darwin_release",
    "systray2\traybin\tray_linux_release",
    "node-notifier\vendor\mac.noindex"
)
foreach ($rel in $prune) {
    $p = Join-Path $nodeModulesDst $rel
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

# 6. A short readme for the folder
@"
PhotoSync Server (for your computer)

SETUP (one time, about a minute):
 1. Keep this whole folder together (for example in Documents). Don't run it
    from inside the .zip.
 2. Double-click PhotoServer.exe.
    - If Windows shows a blue "Windows protected your PC" box, click
      "More info" then "Run anyway". (Normal for free apps not from the Store.)
 3. A dashboard opens in your browser and a green icon appears by the clock
    (bottom-right). Click "Browse..." and choose where to keep your photos
    (an external drive is ideal), then you're done.

That's it. PhotoSync now starts by itself every time you turn the computer on
and runs quietly in the background -- you don't need to open anything. Your
phone backs up whenever it's on the same home Wi-Fi and this computer is on.

To quit or change settings, use the green icon by the clock.
"@ | Set-Content (Join-Path $dist "READ ME.txt") -Encoding utf8

# 7. Report size
$size = [math]::Round((Get-ChildItem $dist -Recurse | Measure-Object Length -Sum).Sum / 1MB, 0)
Write-Host "Done -> $dist  (${size} MB)" -ForegroundColor Green

# 8. Zip it up — a single file to hand to family (extract, double-click).
#    The archive contains a top-level PhotoServer\ folder so extraction is tidy.
$zip = Join-Path (Split-Path $dist -Parent) "PhotoServer-Windows.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $dist -DestinationPath $zip
Write-Host "Zipped -> $zip" -ForegroundColor Green
