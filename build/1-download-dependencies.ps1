# ============================================================
# Step 1: Download all dependencies for offline installation
# Run this script ONCE on a machine WITH internet
# ============================================================
param([string]$OutputDir = "$PSScriptRoot\offline")

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
New-Item -ItemType Directory -Force -Path "$OutputDir\app" | Out-Null
New-Item -ItemType Directory -Force -Path "$OutputDir\tools" | Out-Null

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host " Downloading all dependencies..." -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

# --- 1. Download Node.js LTS (Windows x64) ---
Write-Host "`n[1/4] Downloading Node.js LTS..." -ForegroundColor Yellow
$nodeVer = "20.18.1"
$nodeUrl = "https://nodejs.org/dist/v$nodeVer/node-v$nodeVer-x64.msi"
$nodeDest = "$OutputDir\tools\node-lts-x64.msi"
if (-not (Test-Path $nodeDest)) {
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeDest -UseBasicParsing
    Write-Host "   Node.js downloaded." -ForegroundColor Green
} else { Write-Host "   Node.js already downloaded." -ForegroundColor Gray }

# --- 2. Download NSSM (Windows Service Manager) ---
Write-Host "`n[2/4] Downloading NSSM..." -ForegroundColor Yellow
$nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
$nssmZip = "$OutputDir\tools\nssm.zip"
$nssmDest = "$OutputDir\tools\nssm.exe"
if (-not (Test-Path $nssmDest)) {
    Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($nssmZip)
    $entry = $zip.Entries | Where-Object { $_.FullName -like "*win64/nssm.exe" } | Select-Object -First 1
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nssmDest, $true)
    $zip.Dispose()
    Remove-Item $nssmZip -Force
    Write-Host "   NSSM downloaded." -ForegroundColor Green
} else { Write-Host "   NSSM already downloaded." -ForegroundColor Gray }

# --- 3. Clone/Copy app from GitHub ---
Write-Host "`n[3/4] Cloning project from GitHub..." -ForegroundColor Yellow
$appDir = "$OutputDir\app"
if (Test-Path "$appDir\server.js") {
    Write-Host "   Project already cloned. Pulling latest..." -ForegroundColor Gray
    Push-Location $appDir
    git pull
    Pop-Location
} else {
    git clone https://github.com/tannamnaja-ui/Medical-record-system.git $appDir
    Write-Host "   Project cloned." -ForegroundColor Green
}

# --- 4. npm install (download node_modules) ---
Write-Host "`n[4/4] Installing npm packages..." -ForegroundColor Yellow
Push-Location $appDir
npm install --prefer-offline
Pop-Location
Write-Host "   npm packages installed." -ForegroundColor Green

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host " All dependencies ready!" -ForegroundColor Green
Write-Host " Now run: 2-build-installer.bat" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
