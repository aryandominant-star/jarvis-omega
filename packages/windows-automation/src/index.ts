// Windows integration: hidden PowerShell helpers, app discovery/launch, session state,
// notifications, Task Scheduler startup registration and system metrics.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeviceMetrics } from "../../shared-types/src/index";

const IS_WIN = process.platform === "win32";

/** Run a PowerShell script with no visible window. Returns stdout. */
export function ps(script: string, timeoutMs = 20_000): Promise<string> {
  if (!IS_WIN) return Promise.reject(new Error("PowerShell helpers are only available on Windows"));
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';${script}`, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(0, 500))) : resolve(stdout.trim()))
    );
  });
}

/** Escape a value for a single-quoted PowerShell string literal. */
export const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---------------- applications ----------------
export interface AppEntry { name: string; appId: string }

/** Enumerate Start-menu apps (desktop + Store apps) via the supported Get-StartApps cmdlet. */
export async function discoverApps(): Promise<AppEntry[]> {
  if (!IS_WIN) return [];
  const out = await ps("Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress", 60_000);
  const parsed = out ? JSON.parse(out) : [];
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter((a: any) => a?.Name && a?.AppID)
    .map((a: any) => ({ name: String(a.Name), appId: String(a.AppID) }));
}

/** Launch an app by its AppUserModelID through the shell (works for Win32 and packaged apps). */
export async function launchApp(appId: string, args?: string): Promise<void> {
  if (!IS_WIN) throw new Error("Launching applications is only supported on Windows");
  if (/^[A-Za-z]:\\/.test(appId) || appId.toLowerCase().endsWith(".exe")) {
    await ps(`Start-Process -FilePath ${psq(appId)}${args ? ` -ArgumentList ${psq(args)}` : ""}`);
  } else {
    await ps(`Start-Process ${psq("shell:AppsFolder\\" + appId)}`);
  }
}

export async function listWindows(): Promise<{ pid: number; process: string; title: string }[]> {
  if (!IS_WIN) return [];
  const out = await ps(`Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`);
  const parsed = out ? JSON.parse(out) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p: any) => ({ pid: p.Id, process: p.ProcessName, title: p.MainWindowTitle }));
}

export async function focusWindow(pid: number): Promise<boolean> {
  if (!IS_WIN) return false;
  const out = await ps(`$w = New-Object -ComObject WScript.Shell; $w.AppActivate(${Number(pid)})`);
  return /true/i.test(out);
}

// ---------------- session state ----------------
/** True when the interactive desktop is locked (LogonUI is shown) — desktop automation must pause. */
export async function isWorkstationLocked(): Promise<boolean> {
  if (!IS_WIN) return false;
  try {
    const out = await ps(`[bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue)`, 10_000);
    return /true/i.test(out);
  } catch {
    return false;
  }
}

/**
 * SHQueryUserNotificationState: 1 not present, 2 busy (fullscreen), 3 D3D fullscreen, 4 presentation,
 * 5 accepts notifications, 6 quiet time, 7 app (Windows Store) fullscreen.
 */
export async function userNotificationState(): Promise<number> {
  if (!IS_WIN) return 5;
  try {
    const out = await ps(
      `Add-Type -Namespace J -Name N -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);';` +
        `$s=0; [void][J.N]::SHQueryUserNotificationState([ref]$s); $s`,
      10_000
    );
    return parseInt(out, 10) || 5;
  } catch {
    return 5;
  }
}

export async function batteryStatus(): Promise<{ onBattery: boolean; percent: number | null } | null> {
  if (!IS_WIN) return null;
  try {
    const out = await ps(`Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining | ConvertTo-Json -Compress`, 10_000);
    if (!out) return { onBattery: false, percent: null };
    const b = JSON.parse(out);
    const one = Array.isArray(b) ? b[0] : b;
    return { onBattery: one.BatteryStatus === 1, percent: one.EstimatedChargeRemaining ?? null };
  } catch {
    return null;
  }
}

/** Key identifying the current boot + Windows logon, so the startup toast shows once per sign-in. */
export async function logonKey(): Promise<string> {
  const boot = Math.round((Date.now() - os.uptime() * 1000) / 60000);
  if (!IS_WIN) return `boot-${boot}`;
  try {
    const out = await ps(`(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\\$env:USERNAME" } | Sort-Object StartTime | Select-Object -First 1).StartTime.ToFileTimeUtc()`, 10_000);
    return `boot-${boot}-logon-${out || "x"}`;
  } catch {
    return `boot-${boot}`;
  }
}

// ---------------- notifications ----------------
export interface ToastOptions { title: string; message: string; appId?: string; iconPath?: string }

/** Native Windows toast (via SnoreToast bundled with node-notifier). Silent. */
export async function toast(opts: ToastOptions, log?: (m: string) => void): Promise<void> {
  if (!IS_WIN) {
    log?.(`[toast] ${opts.title}: ${opts.message}`);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WindowsToaster } = require("node-notifier");
  const notifier = new WindowsToaster({ withFallback: false });
  await new Promise<void>((resolve) =>
    notifier.notify(
      { title: opts.title, message: opts.message, appID: opts.appId ?? "Jarvis.Omega", icon: opts.iconPath, sound: false, wait: false },
      () => resolve()
    )
  );
}

// ---------------- startup registration (Task Scheduler) ----------------
export const STARTUP_TASK = "JARVIS OMEGA\\Agent";

function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Builds a per-user, least-privilege scheduled task that starts the agent hidden at sign-in, unlock and resume. */
export function startupTaskXml(exe: string, args: string, userId: string): string {
  const resumeQuery = xmlEscape(
    `<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>`
  );
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the J.A.R.V.I.S. OMEGA background agent for this user. Disable it from the JARVIS tray menu or Task Scheduler.</Description>
    <URI>\\${xmlEscape(STARTUP_TASK)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(userId)}</UserId><Delay>PT15S</Delay></LogonTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><StateChange>SessionUnlock</StateChange><UserId>${xmlEscape(userId)}</UserId></SessionStateChangeTrigger>
    <EventTrigger><Enabled>true</Enabled><Subscription>${resumeQuery}</Subscription><Delay>PT10S</Delay></EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${xmlEscape(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${xmlEscape(exe)}</Command><Arguments>${xmlEscape(args)}</Arguments></Exec>
  </Actions>
</Task>`;
}

function schtasks(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("schtasks.exe", args, { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout)
    )
  );
}

export async function registerStartup(exe: string, args: string): Promise<void> {
  if (!IS_WIN) throw new Error("Startup registration is only supported on Windows");
  const userId = `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`;
  const tmp = path.join(os.tmpdir(), `jarvis-task-${process.pid}.xml`);
  fs.writeFileSync(tmp, "﻿" + startupTaskXml(exe, args, userId), "utf16le");
  try {
    await schtasks(["/Create", "/TN", STARTUP_TASK, "/XML", tmp, "/F"]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export async function setStartupEnabled(enabled: boolean): Promise<void> {
  if (!IS_WIN) return;
  await schtasks(["/Change", "/TN", STARTUP_TASK, enabled ? "/ENABLE" : "/DISABLE"]);
}

export async function startupStatus(): Promise<"enabled" | "disabled" | "missing"> {
  if (!IS_WIN) return "missing";
  try {
    const out = await schtasks(["/Query", "/TN", STARTUP_TASK, "/FO", "CSV", "/NH"]);
    return /Disabled/i.test(out) ? "disabled" : "enabled";
  } catch {
    return "missing";
  }
}

export async function unregisterStartup(): Promise<void> {
  if (!IS_WIN) return;
  await schtasks(["/Delete", "/TN", STARTUP_TASK, "/F"]).catch(() => undefined);
}

// ---------------- metrics ----------------
let lastCpu = os.cpus().map((c) => c.times);
export function cpuPercent(): number {
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] ?? t;
    const d = (k: keyof typeof t) => t[k] - p[k];
    const tot = d("user") + d("nice") + d("sys") + d("irq") + d("idle");
    idle += d("idle");
    total += tot;
  });
  lastCpu = now;
  return total > 0 ? Math.round(((total - idle) / total) * 1000) / 10 : 0;
}

export function diskUsage(): DeviceMetrics["disks"] {
  const roots = IS_WIN ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`) : ["/"];
  const out: DeviceMetrics["disks"] = [];
  for (const r of roots) {
    try {
      if (IS_WIN && !fs.existsSync(r)) continue;
      const s = fs.statfsSync(r);
      const total = s.blocks * s.bsize;
      if (!total) continue;
      out.push({ mount: r, totalBytes: total, usedBytes: total - s.bavail * s.bsize });
    } catch {
      /* removable drive without media, etc. */
    }
  }
  return out;
}

export function collectMetrics(onBattery: boolean | null): DeviceMetrics {
  return {
    cpuPercent: cpuPercent(),
    memTotalBytes: os.totalmem(),
    memUsedBytes: os.totalmem() - os.freemem(),
    disks: diskUsage(),
    uptimeSec: Math.round(os.uptime()),
    onBattery,
  };
}

/** Kill a process and all of its children. */
export function killTree(pid: number) {
  if (IS_WIN) {
    spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}

// ---------------- power control ----------------
import { execFile as _execFile } from "node:child_process";
import type { PowerAction } from "../../shared-types/src/index";

/**
 * Shutdown / restart with a grace window so the person at the PC can cancel (`shutdown /a`).
 * Sleep and lock take effect immediately (both are safely reversible).
 */
export async function powerAction(action: PowerAction, graceSec = 60, reason = "Requested from your JARVIS dashboard"): Promise<void> {
  if (!IS_WIN) throw new Error("Power control is only available on Windows");
  if (action === "lock") {
    await new Promise<void>((res, rej) => _execFile("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true }, (e) => (e ? rej(e) : res())));
    return;
  }
  if (action === "sleep") {
    // false,false = sleep (not hibernate), do not force.
    await new Promise<void>((res, rej) => _execFile("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { windowsHide: true }, (e) => (e ? rej(e) : res())));
    return;
  }
  const flag = action === "restart" ? "/r" : "/s";
  await new Promise<void>((res, rej) =>
    _execFile("shutdown.exe", [flag, "/t", String(Math.max(0, Math.round(graceSec))), "/c", reason.slice(0, 120)], { windowsHide: true }, (e) => (e ? rej(e) : res()))
  );
}

/** Abort a pending shutdown/restart started within its grace window. */
export async function cancelPower(): Promise<boolean> {
  if (!IS_WIN) return false;
  return new Promise((res) => _execFile("shutdown.exe", ["/a"], { windowsHide: true }, (e) => res(!e)));
}

// ---------------- on-screen messenger ----------------
/** Pop a non-blocking message window on the interactive desktop. Returns immediately. */
export async function showMessage(title: string, body: string): Promise<void> {
  if (!IS_WIN) return;
  const script =
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
    `$f=New-Object Windows.Forms.Form;$f.Text=${psq(title)};$f.Size=New-Object Drawing.Size(460,230);` +
    `$f.StartPosition='CenterScreen';$f.TopMost=$true;$f.BackColor=[Drawing.Color]::FromArgb(6,12,22);$f.ForeColor=[Drawing.Color]::FromArgb(220,246,255);` +
    `$f.FormBorderStyle='FixedDialog';$f.MaximizeBox=$false;$f.MinimizeBox=$false;` +
    `$h=New-Object Windows.Forms.Label;$h.Text=${psq(title)};$h.Font=New-Object Drawing.Font('Segoe UI',14,[Drawing.FontStyle]::Bold);$h.ForeColor=[Drawing.Color]::FromArgb(0,229,255);$h.AutoSize=$true;$h.Location='20,16';$f.Controls.Add($h);` +
    `$l=New-Object Windows.Forms.Label;$l.Text=${psq(body)};$l.Font=New-Object Drawing.Font('Segoe UI',11);$l.Location='22,56';$l.Size=New-Object Drawing.Size(410,110);$f.Controls.Add($l);` +
    `$b=New-Object Windows.Forms.Button;$b.Text='Dismiss';$b.Location='350,160';$b.FlatStyle='Flat';$b.ForeColor=[Drawing.Color]::White;$b.Add_Click({$f.Close()});$f.Controls.Add($b);` +
    `$f.Add_Shown({$f.Activate()});[void]$f.ShowDialog()`;
  // Fire and forget — do not await ShowDialog (it blocks until dismissed).
  ps(script, 3600_000).catch(() => undefined);
}

// ---------------- screen capture ----------------
/** Capture the virtual screen to a PNG and return it base64-encoded. Shows a brief on-screen indicator first. */
export async function captureScreen(maxWidth = 1280): Promise<string> {
  if (!IS_WIN) throw new Error("Screen capture is only available on Windows");
  const script =
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
    `$b=[Windows.Forms.SystemInformation]::VirtualScreen;` +
    `$bmp=New-Object Drawing.Bitmap($b.Width,$b.Height);` +
    `$g=[Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size);` +
    `$mw=${Math.round(maxWidth)};if($bmp.Width -gt $mw){$nh=[int]($bmp.Height*$mw/$bmp.Width);$r=New-Object Drawing.Bitmap($mw,$nh);$g2=[Drawing.Graphics]::FromImage($r);$g2.DrawImage($bmp,0,0,$mw,$nh);$bmp.Dispose();$bmp=$r}` +
    `$ms=New-Object IO.MemoryStream;$bmp.Save($ms,[Drawing.Imaging.ImageFormat]::Png);` +
    `[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))`;
  return ps(script, 30_000);
}

/** Briefly flash a small "JARVIS is viewing this screen" banner, so capture is never silent. */
export async function screenIndicator(): Promise<void> {
  if (!IS_WIN) return;
  const script =
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
    `$f=New-Object Windows.Forms.Form;$f.FormBorderStyle='None';$f.BackColor=[Drawing.Color]::Black;$f.TransparencyKey=[Drawing.Color]::Black;` +
    `$f.TopMost=$true;$f.ShowInTaskbar=$false;$f.StartPosition='Manual';$f.Size=New-Object Drawing.Size(360,44);` +
    `$wa=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea;$f.Location=New-Object Drawing.Point($wa.Right-376,$wa.Top+16);` +
    `$l=New-Object Windows.Forms.Label;$l.Text=' ● JARVIS is viewing this screen';$l.ForeColor=[Drawing.Color]::FromArgb(0,229,255);$l.BackColor=[Drawing.Color]::FromArgb(10,20,36);$l.Font=New-Object Drawing.Font('Segoe UI',10,[Drawing.FontStyle]::Bold);$l.Dock='Fill';$l.TextAlign='MiddleLeft';$f.Controls.Add($l);` +
    `$t=New-Object Windows.Forms.Timer;$t.Interval=2500;$t.Add_Tick({$f.Close()});$t.Start();[void]$f.ShowDialog()`;
  ps(script, 10_000).catch(() => undefined);
}
