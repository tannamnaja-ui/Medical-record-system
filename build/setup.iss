; Medical Record System - Inno Setup Script
#define AppName "Medical Record System"
#define AppVersion "1.0.0"
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

[Languages]
Name: "default"; MessagesFile: "compiler:Default.isl"

[Files]
; App files
Source: "offline\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".git,*.log"
; NSSM
Source: "offline\tools\nssm.exe"; DestDir: "{app}\tools"; Flags: ignoreversion
; Node.js installer
Source: "offline\tools\node-lts-x64.msi"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall
; Launcher
Source: "resources\launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion
; Icon
Source: "resources\icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{commondesktop}\ระบบงานเวชระเบียน"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"; Comment: "เปิดระบบ Medical Record"
Name: "{group}\เปิดระบบ"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\icon.ico"; WorkingDir: "{app}"
Name: "{group}\ถอนการติดตั้ง"; Filename: "{uninstallexe}"

[Run]
Filename: "msiexec.exe"; Parameters: "/i ""{tmp}\node-lts-x64.msi"" /qn /norestart"; StatusMsg: "ติดตั้ง Node.js..."; Flags: runhidden waituntilterminated; Check: not IsNodeInstalled
Filename: "{app}\tools\nssm.exe"; Parameters: "install {#ServiceName} node server.js"; StatusMsg: "ติดตั้ง Service..."; Flags: runhidden waituntilterminated; Check: not IsServiceInstalled
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppDirectory ""{app}"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} DisplayName ""Medical Record System"""; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "set {#ServiceName} AppNoConsole 1"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "start {#ServiceName}"; StatusMsg: "เริ่มต้นระบบ..."; Flags: runhidden waituntilterminated
Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; Flags: shellexec postinstall skipifsilent; Description: "เปิดโปรแกรมทันที"

[UninstallRun]
Filename: "{app}\tools\nssm.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated
Filename: "{app}\tools\nssm.exe"; Parameters: "remove {#ServiceName} confirm"; Flags: runhidden waituntilterminated

[Code]
function IsNodeInstalled: Boolean;
var Ver: String;
begin
  Result := RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'Version', Ver) or
            RegQueryStringValue(HKLM64, 'SOFTWARE\Node.js', 'Version', Ver);
end;

function IsServiceInstalled: Boolean;
var ResultCode: Integer;
begin
  Exec('sc.exe', 'query {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := (ResultCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var ConfigFile: String;
begin
  if CurStep = ssInstall then begin
    ConfigFile := ExpandConstant('{app}\config.json');
    if not FileExists(ConfigFile) then begin
      SaveStringToFile(ConfigFile,
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
