@echo off
chcp 65001 >nul
echo =============================================
echo  Build Medical-record-system-Setup-Full.exe
echo =============================================

:: ตรวจสอบว่า offline folder มีไฟล์ครบ
if not exist "offline\app\server.js" (
    echo ERROR: ยังไม่ได้รัน 1-download-dependencies.ps1
    echo กรุณารัน step 1 ก่อน
    pause
    exit /b 1
)

if not exist "offline\tools\node-lts-x64.msi" (
    echo ERROR: ไม่พบ node-lts-x64.msi
    echo กรุณารัน 1-download-dependencies.ps1 ก่อน
    pause
    exit /b 1
)

:: สร้าง dist folder
if not exist "..\dist" mkdir "..\dist"

:: สร้าง resources folder และ icon ถ้าไม่มี
if not exist "resources" mkdir "resources"
if not exist "resources\icon.ico" (
    echo กำลังสร้าง icon...
    powershell -Command "Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(64,64); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.FillRectangle([System.Drawing.Brushes]::DodgerBlue, 0, 0, 64, 64); $g.DrawString('M', (New-Object System.Drawing.Font('Arial',32,[System.Drawing.FontStyle]::Bold)), [System.Drawing.Brushes]::White, 8, 8); $bmp.Save('resources\icon.ico')"
    echo Icon สร้างแล้ว
)

:: ตรวจหา Inno Setup
set ISCC=""
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set ISCC="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" set ISCC="C:\Program Files\Inno Setup 6\ISCC.exe"

if %ISCC%=="" (
    echo.
    echo ERROR: ไม่พบ Inno Setup 6
    echo กรุณาดาวน์โหลดและติดตั้งจาก:
    echo https://jrsoftware.org/isdl.php
    echo.
    pause
    exit /b 1
)

echo กำลัง compile installer...
%ISCC% setup.iss

if %ERRORLEVEL%==0 (
    echo.
    echo =============================================
    echo  สำเร็จ! ไฟล์อยู่ที่:
    echo  dist\Medical-record-system-Setup-Full.exe
    echo =============================================
    explorer "..\dist"
) else (
    echo ERROR: Compile ไม่สำเร็จ
)

pause
