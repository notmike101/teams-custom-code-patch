; Build only through scripts/build-windows.ps1: both assets consume its identical payload.
#ifndef AppVersion
  #error AppVersion must be supplied by the packaging script
#endif
#ifndef PayloadDir
  #error PayloadDir must be supplied by the packaging script
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the packaging script
#endif
#ifndef OutputBaseName
  #error OutputBaseName must be supplied by the packaging script
#endif

[Setup]
AppId={{D3064053-8794-4650-A6B8-9D9E0DFDD388}
AppName=Teams Custom
AppVersion={#AppVersion}
AppVerName=Teams Custom {#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher=Teams Custom contributors
DefaultDirName={localappdata}\Programs\TeamsCustom
DefaultGroupName=Teams Custom
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
AppMutex=Local\TeamsCustomLauncher
SetupMutex=Local\TeamsCustomInstaller
CloseApplications=no
RestartApplications=no
AlwaysRestart=no
RestartIfNeededByRun=no
UninstallDisplayIcon={app}\TeamsCustom.exe
UninstallDisplayName=Teams Custom
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Teams Custom"; Filename: "{app}\TeamsCustom.exe"; WorkingDir: "{app}"

[Messages]
SetupAppRunningError=%1 is running (possibly hidden in the tray).%n%nChoose Exit in the launcher and wait for customization to stop before installing or upgrading. Teams itself does not need to close. Then click OK to continue, or Cancel to exit.
UninstallAppRunningError=%1 is running (possibly hidden in the tray).%n%nChoose Exit in the launcher and wait for customization to stop before uninstalling. Teams itself does not need to close. Then click OK to continue, or Cancel to exit.

[Code]
function InitializeSetup: Boolean;
begin
  Result := IsDotNetInstalled(net48, 0);
  if not Result then
    SuppressibleMsgBox('Teams Custom requires .NET Framework 4.8 or later. Install it through Windows before running this installer.', mbCriticalError, MB_OK, IDOK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if CheckForMutexes('Local\TeamsCustomLauncher') then
    Result := 'Teams Custom started while Setup was open. Choose Exit in its tray menu and wait for customization to stop, then retry. Setup will not close the launcher or Teams.';
end;

{ No Run, InstallDelete, UninstallDelete, process termination, or user-data deletion.
  APPDATA\TeamsCustom is outside the payload and survives normal/silent upgrades/uninstalls. }
