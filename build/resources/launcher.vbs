' launcher.vbs - เปิดโปรแกรมโดยไม่มีหน้าต่าง cmd
' 1. ตรวจสอบ service ถ้าไม่รัน ให้เริ่ม
' 2. เปิด browser ไปที่ http://localhost:3000

Dim oShell, oFSO, appPath, nodePath
Set oShell = CreateObject("WScript.Shell")
Set oFSO = CreateObject("Scripting.FileSystemObject")

' หา installation path จาก registry
Dim installPath
On Error Resume Next
installPath = oShell.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}_is1\InstallLocation")
On Error GoTo 0

If installPath = "" Then
    installPath = "C:\Program Files\Medical Record System\"
End If

' ตรวจสอบ service status
Dim svcStatus
svcStatus = oShell.Run("sc query MedicalRecordSystem", 0, True)

If svcStatus <> 0 Then
    ' Service ไม่รัน → เริ่ม service
    oShell.Run "sc start MedicalRecordSystem", 0, False
    WScript.Sleep 3000
End If

' รอให้ server พร้อม (สูงสุด 10 วินาที)
Dim i, url, xmlHttp
url = "http://localhost:3000"
For i = 1 To 10
    On Error Resume Next
    Set xmlHttp = CreateObject("MSXML2.XMLHTTP")
    xmlHttp.Open "GET", url, False
    xmlHttp.Send
    If xmlHttp.Status = 200 Or xmlHttp.Status = 302 Then
        Exit For
    End If
    On Error GoTo 0
    WScript.Sleep 1000
Next

' เปิด browser
oShell.Run url, 1, False
