# วิธีสร้าง Medical-record-system-Setup-Full.exe

## ขั้นตอน (ทำบน PC ที่มี internet 1 ครั้ง)

### Step 1: ติดตั้ง Inno Setup 6
ดาวน์โหลดฟรีจาก: https://jrsoftware.org/isdl.php

### Step 2: ดาวน์โหลด dependencies
เปิด PowerShell แล้วรัน:
```
cd build
powershell -ExecutionPolicy Bypass -File "1-download-dependencies.ps1"
```
จะดาวน์โหลด:
- Node.js LTS (bundled ใน installer)
- NSSM (service manager)
- Project files + node_modules

### Step 3: Build installer
ดับเบิลคลิก `2-build-installer.bat`

ผลลัพธ์: `dist\Medical-record-system-Setup-Full.exe` (~200-400 MB)

---

## ไฟล์ที่ได้ทำอะไรได้บ้าง

### Medical-record-system-Setup-Full.exe
- ติดตั้งบน Windows ใดก็ได้ ไม่ต้องการ internet
- ตรวจสอบ Node.js → ถ้ามีแล้วข้ามการติดตั้ง
- ติดตั้ง Windows Service (ไม่มีหน้าต่าง cmd)
- Service เริ่มอัตโนมัติเมื่อเปิดคอมพิวเตอร์
- สร้าง Desktop shortcut "ระบบงานเวชระเบียน"

### หลังติดตั้ง
- ดับเบิลคลิก shortcut → เปิด browser อัตโนมัติ
- URL: http://localhost:3000
- ตั้งค่า DB ครั้งแรกที่ http://localhost:3000/settings.html

---

## Requirements ของเครื่องที่จะติดตั้ง
- Windows 10/11 (64-bit)
- RAM อย่างน้อย 2 GB
- พื้นที่ว่าง 500 MB
- ไม่ต้องการ internet หลังติดตั้ง
