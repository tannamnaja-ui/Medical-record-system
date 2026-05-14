@echo off
chcp 65001 >nul
echo ========================================
echo  ระบบลงวินิจฉัย ICD10
echo  http://localhost:3000
echo ========================================
echo.
cd /d "%~dp0"
node server.js
pause
