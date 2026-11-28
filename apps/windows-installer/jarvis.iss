; J.A.R.V.I.S. OMEGA — Windows installer (Inno Setup 6)
; Build:  iscc /DAppVersion=1.0.0 /DDefaultApiUrl=https://… /DStage=..\..\dist\win jarvis.iss
; Stages: Welcome → License & permissions → Device pairing → Workspace → Browser → Voice →
;         Cloud connectivity → Automatic startup → Agent initialization → Finished

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef DefaultApiUrl
  #define DefaultApiUrl ""
#endif
#ifndef DefaultPairCode
  ; Bake a reusable enrollment code here (Devices → "Create enrollment code") to ship a pre-configured
  ; installer that pairs and starts itself with nothing for the user to type.
  #define DefaultPairCode ""
#endif
#ifndef Stage
  #define Stage "..\..\dist\win"
#endif

[Setup]
AppId={{6B0E6E2A-7C1D-4E55-9A8B-1F4A0D5C2E01}
AppName=J.A.R.V.I.S. OMEGA
AppVersion={#AppVersion}
AppPublisher=J.A.R.V.I.S. OMEGA
AppVerName=J.A.R.V.I.S. OMEGA {#AppVersion}
DefaultDirName={localappdata}\Programs\JARVIS
DefaultGroupName=J.A.R.V.I.S.
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=JARVIS-Setup
SetupIconFile={#Stage}\app\assets\jarvis.ico
UninstallDisplayIcon={app}\app\assets\jarvis.ico
UninstallDisplayName=J.A.R.V.I.S. OMEGA
LicenseFile=LICENSE-AND-PERMISSIONS.txt
WizardStyle=modern
WizardSizePercent=110
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=no
RestartApplications=no
MinVersion=10.0.17763

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Welcome to J.A.R.V.I.S. OMEGA
WelcomeLabel2=This installs the J.A.R.V.I.S. agent on this computer so it can be controlled from your JARVIS command center.%n%nNothing runs with administrator rights. You choose what JARVIS may access, and you can pause, disconnect or uninstall it at any time from the tray icon.
FinishedHeadingLabel=J.A.R.V.I.S. is installed
FinishedLabel=The agent is running in the notification area (look for the blue ring icon).

[Files]
Source: "{#Stage}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "LICENSE-AND-PERMISSIONS.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The AppUserModelID lets Windows show toasts as "J.A.R.V.I.S." with our icon.
Name: "{userprograms}\J.A.R.V.I.S.\J.A.R.V.I.S."; Filename: "{app}\runtime\jarvisw.exe"; Parameters: """{app}\app\agent.cjs"" --background"; WorkingDir: "{app}"; IconFilename: "{app}\app\assets\jarvis.ico"; AppUserModelID: "Jarvis.Omega"
Name: "{userprograms}\J.A.R.V.I.S.\JARVIS Command Center"; Filename: "{code:GetApiUrl}"; IconFilename: "{app}\app\assets\jarvis.ico"; Check: HasApiUrl
Name: "{userprograms}\J.A.R.V.I.S.\Uninstall J.A.R.V.I.S."; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\runtime\jarvisw.exe"; Parameters: """{app}\app\agent.cjs"" codex-login"; WorkingDir: "{app}"; Description: "Connect Codex now (opens the ChatGPT sign-in page in your browser)"; Flags: postinstall nowait skipifsilent
Filename: "{code:GetApiUrl}"; Description: "Open the JARVIS command center"; Flags: postinstall shellexec nowait skipifsilent unchecked; Check: HasApiUrl

[UninstallRun]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\agent.cjs"" stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopAgent"
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\agent.cjs"" startup remove"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveStartup"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  PairPage: TInputQueryWizardPage;
  WorkspacePage: TInputDirWizardPage;
  BrowserPage: TInputOptionWizardPage;
  VoicePage: TInputOptionWizardPage;
  CloudPage: TOutputMsgWizardPage;
  StartupPage: TInputOptionWizardPage;
  CloudOk: Boolean;

function GetApiUrl(Param: String): String;
var S: String;
begin
  S := Trim(PairPage.Values[0]);
  while (Length(S) > 0) and (S[Length(S)] = '/') do S := Copy(S, 1, Length(S) - 1);
  Result := S;
end;

function HasApiUrl(): Boolean;
begin
  Result := GetApiUrl('') <> '';
end;

function Quote(S: String): String;
begin
  Result := '"' + S + '"';
end;

procedure InitializeWizard();
begin
  PairPage := CreateInputQueryPage(wpLicense, 'Device pairing',
    'Connect this PC to your JARVIS account',
    'Sign in to your JARVIS command center, open Devices, click "Generate pairing code" and enter it below. ' +
    'The code works once and expires after 10 minutes. You can also leave it empty and pair later from the tray menu.');
  PairPage.Add('Command center address:', False);
  PairPage.Add('Pairing code (e.g. ABCD-EFGH):', False);
  PairPage.Add('Name for this PC:', False);
  PairPage.Values[0] := '{#DefaultApiUrl}';
  PairPage.Values[1] := '{#DefaultPairCode}';
  PairPage.Values[2] := Uppercase(GetComputerNameString());

  WorkspacePage := CreateInputDirPage(PairPage.ID, 'Workspace',
    'Where should JARVIS keep its files?',
    'JARVIS saves reports and documents here and may only read and write inside the folders you approve. ' +
    'You can approve more folders later in the command center.', False, 'JARVIS');
  WorkspacePage.Add('Workspace folder:');
  WorkspacePage.Values[0] := ExpandConstant('{userdocs}\JARVIS');

  BrowserPage := CreateInputOptionPage(WorkspacePage.ID, 'Browser integration',
    'Which browser should JARVIS drive?',
    'JARVIS uses its own browser profile, so your sign-ins there persist between tasks. Passwords you save in the ' +
    'JARVIS vault are typed into login pages directly and are never shown to the AI.', True, False);
  BrowserPage.Add('Google Chrome');
  BrowserPage.Add('Microsoft Edge');
  BrowserPage.SelectedValueIndex := 0;

  VoicePage := CreateInputOptionPage(BrowserPage.ID, 'Voice',
    'Local voice assistant',
    'Offline Windows speech recognition listens for "Hey Jarvis" on this PC. Audio never leaves the computer. ' +
    'JARVIS never speaks at startup. You can switch voice on or off from the tray menu.', False, False);
  VoicePage.Add('Enable "Hey Jarvis" on this PC');
  VoicePage.Values[0] := False;

  CloudPage := CreateOutputMsgPage(VoicePage.ID, 'Cloud connectivity',
    'Checking the connection to your command center', '');

  StartupPage := CreateInputOptionPage(CloudPage.ID, 'Automatic startup',
    'Start JARVIS when you sign in to Windows?',
    'If enabled, a per-user Windows scheduled task named "JARVIS OMEGA\Agent" starts the agent quietly at sign-in, ' +
    'after unlocking and after waking from sleep. It runs without administrator rights and shows one small ' +
    'notification when ready. You can turn this off from the tray menu ("Start with Windows") at any time.', False, False);
  StartupPage.Add('Start J.A.R.V.I.S. automatically when I sign in (recommended)');
  StartupPage.Values[0] := True;
end;

function CheckHealth(Url: String; var Msg: String): Boolean;
var Http: Variant; Status: Integer; Body: String;
begin
  Result := False;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.SetTimeouts(5000, 5000, 10000, 10000);
    Http.Open('GET', Url + '/api/health', False);
    Http.Send('');
    Status := Http.Status;
    Body := Http.ResponseText;
    if (Status = 200) and (Pos('"ok":true', Body) > 0) then begin
      Result := True;
      Msg := 'Connected to ' + Url + '. The control plane is online.';
    end else
      Msg := 'The server answered with HTTP ' + IntToStr(Status) + '. Check the address.';
  except
    Msg := 'Could not reach ' + Url + ': ' + GetExceptionMessage;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
var Msg: String;
begin
  if CurPageID = CloudPage.ID then begin
    if not HasApiUrl() then begin
      CloudOk := False;
      CloudPage.MsgLabel.Caption := 'No command center address was entered. JARVIS will be installed offline; pair it later from the tray menu.';
    end else begin
      CloudPage.MsgLabel.Caption := 'Contacting ' + GetApiUrl('') + ' …';
      WizardForm.Refresh;
      CloudOk := CheckHealth(GetApiUrl(''), Msg);
      CloudPage.MsgLabel.Caption := Msg;
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var U: String;
begin
  Result := True;
  if CurPageID = PairPage.ID then begin
    U := GetApiUrl('');
    if (U <> '') and (Pos('https://', Lowercase(U)) <> 1) and (Pos('http://localhost', Lowercase(U)) <> 1) then begin
      MsgBox('The command center address must start with https://', mbError, MB_OK);
      Result := False;
    end;
    if Result and (Trim(PairPage.Values[1]) <> '') and (Length(Trim(PairPage.Values[1])) < 8) then begin
      MsgBox('Pairing codes look like ABCD-EFGH.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if (CurPageID = CloudPage.ID) and HasApiUrl() and not CloudOk then
    Result := MsgBox('The command center could not be reached. Continue anyway and pair later?', mbConfirmation, MB_YESNO) = IDYES;
end;

function RunAgent(Params: String; Hidden: Boolean): Integer;
var Code: Integer;
begin
  if not Exec(ExpandConstant('{app}\runtime\node.exe'), Quote(ExpandConstant('{app}\app\agent.cjs')) + ' ' + Params,
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then Code := -1;
  Result := Code;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  // Upgrading: stop the running agent so its files can be replaced.
  if FileExists(ExpandConstant('{app}\app\agent.cjs')) then
    Exec(ExpandConstant('{app}\runtime\node.exe'), Quote(ExpandConstant('{app}\app\agent.cjs')) + ' stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Code: Integer; Args: String;
begin
  if CurStep <> ssPostInstall then exit;
  WizardForm.StatusLabel.Caption := 'Agent initialization: writing your permission policy…';
  Args := 'init --workspace ' + Quote(WorkspacePage.Values[0]);
  if BrowserPage.SelectedValueIndex = 1 then Args := Args + ' --browser msedge' else Args := Args + ' --browser chrome';
  if VoicePage.Values[0] then Args := Args + ' --voice true' else Args := Args + ' --voice false';
  if HasApiUrl() then Args := Args + ' --url ' + Quote(GetApiUrl(''));
  RunAgent(Args, True);

  if HasApiUrl() and (Trim(PairPage.Values[1]) <> '') then begin
    WizardForm.StatusLabel.Caption := 'Agent initialization: pairing this PC…';
    Code := RunAgent('pair --url ' + Quote(GetApiUrl('')) + ' --code ' + Quote(Trim(PairPage.Values[1])) + ' --name ' + Quote(Trim(PairPage.Values[2])), True);
    if Code <> 0 then
      MsgBox('Pairing did not succeed (the code may have expired). JARVIS is installed — choose "Pair this PC…" from its tray menu to finish.', mbInformation, MB_OK);
  end;

  if StartupPage.Values[0] then begin
    WizardForm.StatusLabel.Caption := 'Agent initialization: registering automatic startup…';
    RunAgent('startup register', True);
  end;

  WizardForm.StatusLabel.Caption := 'Agent initialization: starting J.A.R.V.I.S.…';
  Exec(ExpandConstant('{app}\runtime\jarvisw.exe'), Quote(ExpandConstant('{app}\app\agent.cjs')) + ' --background',
       ExpandConstant('{app}'), SW_HIDE, ewNoWait, Code);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if MsgBox('Also delete JARVIS data on this PC (memory, credential vault, logs, browser profile)?', mbConfirmation, MB_YESNO) = IDYES then
      DelTree(ExpandConstant('{userappdata}\JARVIS'), True, True, True);
end;
