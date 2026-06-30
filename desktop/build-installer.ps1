# Builds the PhotoSync Server Windows installer (.exe).
# Requires Inno Setup 6 — iscc.exe must be on PATH or in the default install dir.
# Usage: npm run installer   (from the desktop folder)

$ErrorActionPreference = "Stop"
$desktop = $PSScriptRoot

# ── 1. Build the portable folder (same content the zip uses) ──────────────────
Write-Host "Step 1/2 — building portable folder..." -ForegroundColor Cyan
& powershell -NoProfile -File (Join-Path $desktop "build-portable.ps1")

# ── 2. Compile the installer ──────────────────────────────────────────────────
Write-Host "Step 2/2 — compiling installer..." -ForegroundColor Cyan

# Read the version from desktop/package.json so stamp-version keeps everything in sync.
$pkg = Get-Content (Join-Path $desktop "package.json") -Raw | ConvertFrom-Json
$ver = $pkg.version

# Find iscc.exe (Inno Setup compiler).
$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
if (-not $iscc) {
    $candidates = @(
        "C:\Program Files (x86)\Inno Setup 6\iscc.exe",
        "C:\Program Files\Inno Setup 6\iscc.exe"
    )
    $iscc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $iscc) {
    throw "iscc.exe not found. Install Inno Setup 6 from https://jrsoftware.org/isdownload.php"
}

$iss  = Join-Path $desktop "installer.iss"
& $iscc /DAppVersion=$ver $iss
if ($LASTEXITCODE -ne 0) { throw "iscc failed (exit $LASTEXITCODE)" }

# Also produce a fixed-name copy for the stable download link.
$versionedExe = Join-Path $desktop "dist\PhotoSync-Server-Setup-$ver.exe"
$stableExe    = Join-Path $desktop "dist\PhotoSync-Server-Setup.exe"
if (Test-Path $versionedExe) {
    Copy-Item $versionedExe $stableExe -Force
    Write-Host "Installer -> $versionedExe" -ForegroundColor Green
    Write-Host "Stable    -> $stableExe" -ForegroundColor Green
} else {
    throw "Expected installer not found at $versionedExe"
}
