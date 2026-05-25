# ============================================================
# Step 1: Download all dependencies for offline installation
# Run this script ONCE on a machine WITH internet
# ============================================================
param([string]$OutputDir = "$PSScriptRoot\offline")

$ErrorActionPreference = 'Stop'
$GithubRepo = "https://github.com/tannamnaja-ui/Medical-record-system.git"

New-Item -ItemType Directory -Force -Path "$OutputDir\tools" | Out-Null
New-Item -ItemType Directory -Force -Path "$OutputDir\app"   | Out-Null

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host " Downloading all dependencies..." -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

# --- 1. Download Node.js LTS (Windows x64) ---
Write-Host "`n[1/4] Node.js LTS..." -ForegroundColor Yellow
$nodeVer  = "20.18.1"
$nodeUrl  = "https://nodejs.org/dist/v$nodeVer/node-v$nodeVer-x64.msi"
$nodeDest = "$OutputDir\tools\node-lts-x64.msi"
if (-not (Test-Path $nodeDest)) {
    Write-Host "   Downloading Node.js v$nodeVer..." -ForegroundColor Gray
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeDest -UseBasicParsing
    Write-Host "   Done." -ForegroundColor Green
} else { Write-Host "   Already downloaded." -ForegroundColor Gray }

# --- 2. Download NSSM (Windows Service Manager) ---
Write-Host "`n[2/4] NSSM (Windows Service Manager)..." -ForegroundColor Yellow
$nssmDest = "$OutputDir\tools\nssm.exe"
if (-not (Test-Path $nssmDest)) {
    $nssmZip = "$OutputDir\tools\nssm.zip"
    Write-Host "   Downloading NSSM..." -ForegroundColor Gray
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip -UseBasicParsing
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip   = [System.IO.Compression.ZipFile]::OpenRead($nssmZip)
    $entry = $zip.Entries | Where-Object { $_.FullName -like "*win64/nssm.exe" } | Select-Object -First 1
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nssmDest, $true)
    $zip.Dispose()
    Remove-Item $nssmZip -Force
    Write-Host "   Done." -ForegroundColor Green
} else { Write-Host "   Already downloaded." -ForegroundColor Gray }

# --- 3. Clone app from GitHub (ดึงเฉพาะโฟลเดอร์ build/offline/app) ---
Write-Host "`n[3/4] Cloning app from GitHub..." -ForegroundColor Yellow
$tempRepo = "$OutputDir\..\_temp_clone"

if (Test-Path $tempRepo) { Remove-Item $tempRepo -Recurse -Force }

# shallow clone เพื่อความเร็ว
git clone --depth 1 $GithubRepo $tempRepo
if ($LASTEXITCODE -ne 0) { throw "git clone failed" }

# app อยู่ใน build/offline/app/ ของ repo
$repoAppSrc = "$tempRepo\build\offline\app"
if (-not (Test-Path "$repoAppSrc\server.js")) {
    throw "ไม่พบ server.js ใน $repoAppSrc — ตรวจสอบโครงสร้าง repo"
}

$appDest = "$OutputDir\app"
Write-Host "   Copying app files..." -ForegroundColor Gray
# copy ทุกอย่างยกเว้น build/, dist/, node_modules/ (จะ npm install ใหม่)
robocopy $repoAppSrc $appDest /E /XD "build" "dist" "node_modules" ".git" /NFL /NDL /NJH /NJS | Out-Null

# ลบ temp repo
Remove-Item $tempRepo -Recurse -Force
Write-Host "   Done." -ForegroundColor Green

# --- 4. npm install (เก็บ node_modules ใน offline/app) ---
Write-Host "`n[4/4] npm install..." -ForegroundColor Yellow
Push-Location $appDest
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
Pop-Location
Write-Host "   Done." -ForegroundColor Green

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host " All dependencies ready!" -ForegroundColor Green
Write-Host " Now run: 2-build-installer.bat" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
