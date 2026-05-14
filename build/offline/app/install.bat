@echo off
chcp 65001 >nul
echo ========================================
echo  ติดตั้ง ระบบลงวินิจฉัย ICD10
echo ========================================
echo.
cd /d "%~dp0"
echo กำลังติดตั้ง dependencies...
npm install
echo.
echo ติดตั้งเสร็จแล้ว! รัน start.bat เพื่อเริ่มใช้งาน
echo.
pause
