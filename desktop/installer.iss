; Inno Setup script for PhotoSync Server (Windows)
; Build with:  iscc /DAppVersion=0.7.0 installer.iss
; Or via npm:  npm run installer  (from the desktop folder)

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

[Setup]
AppName=PhotoSync Server
AppVersion={#AppVersion}
AppPublisher=Daniel Gamiz
AppPublisherURL=https://danielgamiz-alt.github.io/PhotoServer/
AppSupportURL=https://github.com/danielgamiz-alt/PhotoServer
AppUpdatesURL=https://github.com/danielgamiz-alt/PhotoServer/releases

; Install to %LocalAppData%\PhotoSync Server — no admin prompt needed.
DefaultDirName={localappdata}\PhotoSync Server
DisableDirPage=yes

DefaultGroupName=PhotoSync Server
DisableProgramGroupPage=yes

; Installer output
OutputDir=dist
OutputBaseFilename=PhotoSync-Server-Setup-{#AppVersion}

; Also produce a fixed-name copy for the stable download link on the landing page.
; (Copied in build-installer.ps1 after iscc runs.)

SetupIconFile=assets\app.ico
UninstallDisplayIcon={app}\PhotoSync Server.exe
UninstallDisplayName=PhotoSync Server

Compression=lzma2/ultra64
SolidCompression=yes

; No admin — per-user install.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=

; Ask the user to close any running PhotoSync Server before updating.
CloseApplications=yes
CloseApplicationsFilter=PhotoSync Server.exe,node.exe

; Cosmetic
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
; The portable build produces dist\PhotoSync Server\ — copy everything from there.
Source: "dist\PhotoSync Server\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Start Menu
Name: "{group}\PhotoSync Server"; Filename: "{app}\PhotoSync Server.exe"
Name: "{group}\Uninstall PhotoSync Server"; Filename: "{uninstallexe}"
; Desktop (only if the user ticked the box)
Name: "{userdesktop}\PhotoSync Server"; Filename: "{app}\PhotoSync Server.exe"; Tasks: desktopicon

[Run]
; Launch the app after install (user can untick the checkbox).
Filename: "{app}\PhotoSync Server.exe"; Description: "Launch PhotoSync Server now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the app before uninstalling so files can be removed cleanly.
Filename: "taskkill"; Parameters: "/f /im ""PhotoSync Server.exe"""; Flags: runhidden waituntilterminated; RunOnceId: "KillApp"
Filename: "taskkill"; Parameters: "/f /im node.exe"; Flags: runhidden waituntilterminated; RunOnceId: "KillNode"
