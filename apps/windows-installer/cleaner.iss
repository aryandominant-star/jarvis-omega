; J.A.R.V.I.S. OMEGA — standalone cleaner. Produces JARVIS-Uninstall.exe.
; Removes everything with no runtime dependency: stops the agent, deletes the startup task,
; and removes the app and all local data (memory, vault, logs, browser profile).
; Build: iscc /DAppVersion=1.1.0 cleaner.iss

#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif

[Setup]
AppId={{6B0E6E2A-7C1D-4E55-9A8B-1F4A0D5C2E01}
AppName=J.A.R.V.I.S. OMEGA Cleaner
AppVersion={#AppVersion}
CreateAppDir=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=JARVIS-Uninstall
Uninstallable=no
DisableWelcomePage=no
WizardStyle=modern
UninstallDisplayName=J.A.R.V.I.S. OMEGA Cleaner

[Messages]
WelcomeLabel1=Remove J.A.R.V.I.S. OMEGA
WelcomeLabel2=This will stop the JARVIS agent on this computer, remove its automatic-startup task, and delete the app and all of its local data (memory, credential vault, logs and browser profile).%n%nThis does not touch your account or your other computers. Click Next to remove it.
FinishedHeadingLabel=J.A.R.V.I.S. removed
FinishedLabel=The agent has been stopped and removed from this computer.

[Code]
procedure RunHidden(const Exe, Params: String);
var Code: Integer;
begin
  Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var App: String;
begin
  if CurStep <> ssInstall then exit;
  App := ExpandConstant('{localappdata}\Programs\JARVIS');
  WizardForm.StatusLabel.Caption := 'Stopping the agent…';
  if FileExists(App + '\runtime\node.exe') then
    RunHidden(App + '\runtime\node.exe', '"' + App + '\app\agent.cjs" stop');
  RunHidden(ExpandConstant('{cmd}'), '/c taskkill /F /IM jarvisw.exe /T');
  WizardForm.StatusLabel.Caption := 'Removing automatic startup…';
  RunHidden(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN "JARVIS OMEGA\Agent" /F');
  WizardForm.StatusLabel.Caption := 'Deleting data…';
  DelTree(ExpandConstant('{userappdata}\JARVIS'), True, True, True);
  DelTree(App, True, True, True);
  RemoveDir(ExpandConstant('{userprograms}\J.A.R.V.I.S.'));
end;
