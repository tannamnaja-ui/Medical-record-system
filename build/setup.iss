; ============================================================
; Medical Record System - Inno Setup Script
; Compiles to: Medical-record-system-Setup-Full.exe
; ============================================================
#define AppName "Medical Record System"
#define AppVersion "1.0.0"
#define AppPublisher "กลุ่มงานเวชระเบียน"
#define AppURL "http://localhost:3000"
#define AppExeName "medical-record.exe"
#define ServiceName "MedicalRecordSystem"
#define InstallDir "{autopf}\Medical Record System"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={#InstallDir}
DefaultGroupName={#AppName}
OutputDir=..\dist
OutputBaseFilename=Medical-record-system-Setup-Full
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\launcher.ico
SetupIconFile=resources\icon.ico
DisableWelcomePage=no
LicenseFile=
InfoBeforeFile=
InfoAfterFile=

[Languages]
Name: "thai"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "ติดตั้งแบบสมบูรณ์"

[Components]
Name: "main"; Description: "โปรแกรมหลัก"; Types: full; Flags: fixed
Name: "nodejs"; Description: "Node.js Runtime (ถ้ายังไม่ได้ติดตั้ง)"; Types: full

[Files]
; App files
Source: "offline\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".git,*.log"
; NSSM service manager
Source: "offline\tools\nssm.exe"; DestDir: "{app}\tools"; Flags: ignoreversion
; Node.js installer (bundled)
Source: "offline\tools\node-lts-x64.msi"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall; Components: nodejs
; Launcher VBS (no cmd window)
Source: "resources\launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion
; Icons
Source: "resources\icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\เปิดระบบเวชระเบียน"; Filename: "{app}\tools\nssm.exe"; Parameters: ""; IconFilename: "{app}\icon.ico"; Comment: "เปิดระบบ Medical Record"
Name: "{group}\เปิดระบบเวชระเบียน"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"
Name: "{commondesktop}\ระบบงานเวชระเบียน"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"; Comment: "เปิดระบบ Medical Record System"
Name: "{group}\หยุดระบบ"; Filename: "{app}\tools\nssm.exe"; Parameters: "stop {#ServiceName}"; IconFilename: "{app}\icon.ico"
Name: "{group}\ถอนการติดตั้ง"; Filename: "{uninstallexe}"

[Run]
; 1. Install Node.js if not already installed
Filename: "msiexec.exe"; Parameters: "/i ""{tmp}\node-lts-x64.msi"" /qn /norestart"; StatusMsg: "กำลังติดตั้ง Node.js..."; Components: nodejs; Flags: runhidden waituntilterminated; Check: not IsNodeInstalled

; 2. Install Windows Service (no cmd window)
Filename: "{app}\tools\nssm.exe"; Parameters: "install {#ServiceName} ""{app}\tools\node.cmd"" ""server.js"""; StatusMsg: "กำลังติดตั้ง Windows Service..."; Flags: runhidden waituntilterminated; Check: not IsServiceInstalled

; 3. Set service working directory
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppDirectory ""{app}"""; Flags: runhidden waituntilterminated

; 4. Set service display name
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} DisplayName ""Medical Record System"""; Flags: runhidden waituntilterminated

; 5. Set service to auto-start
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated

; 6. Set no window
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppNoConsole 1"; Flags: runhidden waituntilterminated

; 7. Start the service
Filename: "{app}\tools\nssm.exe"; Parameters: "start {#ServiceName}"; StatusMsg: "กำลังเริ่มต้นระบบ..."; Flags: runhidden waituntilterminated

; 8. Open browser after install
Filename: "{app}\launcher.vbs"; StatusMsg: "เปิดโปรแกรม..."; Flags: shellexec skipifdoesntexist postinstall; Description: "เปิดโปรแกรมทันที"

[UninstallRun]
Filename: "{app}\tools\nssm.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "remove {#ServiceName} confirm"; Flags: runhidden waituntilterminated

[Code]
function IsNodeInstalled: Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'Version', Version) or
            RegQueryStringValue(HKLM64, 'SOFTWARE\Node.js', 'Version', Version);
  if Result then
    Log('Node.js found: ' + Version)
  else
    Log('Node.js not found, will install');
end;

function IsServiceInstalled: Boolean;
var
  ResultCode: Integer;
begin
  Exec('sc', 'query {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := (ResultCode = 0);
  if Result then
    Log('Service already installed, skipping')
  else
    Log('Service not found, will install');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstallFiles then begin
    // Create default config.json if not exists
    if not FileExists(ExpandConstant('{app}\config.json')) then begin
      SaveStringToFile(ExpandConstant('{app}\config.json'),
        '{' + #13#10 +
        '  "dbType": "postgresql",' + #13#10 +
        '  "host": "localhost",' + #13#10 +
        '  "port": "5432",' + #13#10 +
        '  "database": "",' + #13#10 +
        '  "username": "",' + #13#10 +
        '  "password": ""' + #13#10 +
        '}', False);
    end;
  end;
end;
