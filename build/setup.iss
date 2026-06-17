; Medical Record System - Inno Setup Script v1.2.1
#define AppName "Medical Record System"
#define AppVersion "1.2.1"
#define ServiceName "MedicalRecordSystem"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=กลุ่มงานเวชระเบียน
DefaultDirName={autopf}\Medical Record System
DefaultGroupName={#AppName}
OutputDir=..\dist
OutputBaseFilename=Medical-record-system-Setup-Full
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile=resources\icon.ico
UninstallDisplayIcon={app}\icon.ico
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "default"; MessagesFile: "compiler:Default.isl"

[Files]
; App source files
Source: "offline\app\server.js";           DestDir: "{app}"; Flags: ignoreversion
Source: "offline\app\package.json";        DestDir: "{app}"; Flags: ignoreversion
Source: "offline\app\package-lock.json";   DestDir: "{app}"; Flags: ignoreversion
Source: "offline\app\config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "offline\app\public\*";            DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "offline\app\node_modules\*";      DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
; NSSM (Windows Service manager)
Source: "offline\tools\nssm.exe";          DestDir: "{app}\tools"; Flags: ignoreversion
; Node.js installer (extracted to temp, deleted after install)
Source: "offline\tools\node-lts-x64.msi";  DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall
; Launcher & icon
Source: "resources\launcher.vbs";          DestDir: "{app}"; Flags: ignoreversion
Source: "resources\icon.ico";              DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{commondesktop}\ระบบงานเวชระเบียน"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"; Comment: "เปิดระบบ Medical Record"
Name: "{group}\เปิดระบบ";        Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"
Name: "{group}\ถอนการติดตั้ง";   Filename: "{uninstallexe}"

[Run]
; ติดตั้ง Node.js เฉพาะเมื่อยังไม่มี
Filename: "msiexec.exe"; Parameters: "/i ""{tmp}\node-lts-x64.msi"" /qn /norestart ADDLOCAL=ALL"; StatusMsg: "ติดตั้ง Node.js..."; Flags: runhidden waituntilterminated; Check: not IsNodeInstalled
; หยุดและลบ service เก่า (กรณี upgrade)
Filename: "{app}\tools\nssm.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated; Check: IsServiceInstalled
Filename: "{app}\tools\nssm.exe"; Parameters: "remove {#ServiceName} confirm"; Flags: runhidden waituntilterminated; Check: IsServiceInstalled
; ติดตั้ง Windows Service ใหม่ โดยใช้ path node.exe ที่ detect ได้
; หมายเหตุ: ต้องตั้งค่า server.js ผ่าน "set AppParameters" แยกขั้นตอน ไม่ใส่รวมกับ
; "install" เพราะ NSSM แตก argument ที่มีช่องว่าง (เช่น "C:\Program Files...") ผิดพลาด
; ทำให้ Node หา module ไม่เจอ (error: Cannot find module 'C:\Program')
Filename: "{app}\tools\nssm.exe"; Parameters: "install {#ServiceName} ""{code:GetNodeExePath}"""; StatusMsg: "ลงทะเบียน Windows Service..."; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppParameters ""{app}\server.js"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppDirectory ""{app}"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} DisplayName ""Medical Record System"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} Description ""ระบบงานเวชระเบียน - Medical Record System"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppNoConsole 1"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppStdout ""{app}\logs\service.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppStderr ""{app}\logs\error.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppRotateFiles 1"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppRotateBytes 10485760"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "start {#ServiceName}"; StatusMsg: "เริ่มต้นระบบ..."; Flags: runhidden waituntilterminated
; เปิดโปรแกรมทันทีหลังติดตั้ง
Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; Flags: shellexec postinstall skipifsilent; Description: "เปิดโปรแกรมทันที"

[UninstallRun]
Filename: "{app}\tools\nssm.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated; Check: IsServiceInstalled
Filename: "{app}\tools\nssm.exe"; Parameters: "remove {#ServiceName} confirm"; Flags: runhidden waituntilterminated; Check: IsServiceInstalled

[Dirs]
Name: "{app}\logs"

[Code]
{ ---- หา path ของ node.exe ---- }
function GetNodeExePath(Param: String): String;
var
  InstallPath: String;
begin
  { ลองอ่านจาก registry (MSI ใหม่ๆ บันทึกที่นี่) }
  if RegQueryStringValue(HKLM64, 'SOFTWARE\Node.js', 'InstallPath', InstallPath) or
     RegQueryStringValue(HKLM,   'SOFTWARE\Node.js', 'InstallPath', InstallPath) then
  begin
    if FileExists(InstallPath + '\node.exe') then
    begin
      Result := InstallPath + '\node.exe';
      Exit;
    end;
  end;
  { fallback: path มาตรฐาน }
  if FileExists('C:\Program Files\nodejs\node.exe') then
    Result := 'C:\Program Files\nodejs\node.exe'
  else if FileExists('C:\Program Files (x86)\nodejs\node.exe') then
    Result := 'C:\Program Files (x86)\nodejs\node.exe'
  else
    Result := 'node.exe'; { ใช้ PATH เป็น last resort }
end;

{ ---- ตรวจสอบ Node.js ---- }
function IsNodeInstalled: Boolean;
var
  Ver: String;
begin
  Result := RegQueryStringValue(HKLM64, 'SOFTWARE\Node.js', 'Version', Ver) or
            RegQueryStringValue(HKLM,   'SOFTWARE\Node.js', 'Version', Ver);
  if not Result then
    Result := FileExists('C:\Program Files\nodejs\node.exe') or
              FileExists('C:\Program Files (x86)\nodejs\node.exe');
end;

{ ---- ตรวจสอบ Service ---- }
function IsServiceInstalled: Boolean;
var ResultCode: Integer;
begin
  Exec('sc.exe', 'query {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := (ResultCode = 0);
end;

{ ---- สร้าง config.json เริ่มต้น (ถ้ายังไม่มี) ---- }
procedure CurStepChanged(CurStep: TSetupStep);
var ConfigFile: String;
begin
  if CurStep = ssPostInstall then begin
    ConfigFile := ExpandConstant('{app}\config.json');
    if not FileExists(ConfigFile) then begin
      SaveStringToFile(ConfigFile,
        '{' + #13#10 +
        '  "dbType": "mysql",' + #13#10 +
        '  "host": "localhost",' + #13#10 +
        '  "port": "3306",' + #13#10 +
        '  "database": "",' + #13#10 +
        '  "username": "",' + #13#10 +
        '  "password": ""' + #13#10 +
        '}', False);
    end;
  end;
end;
