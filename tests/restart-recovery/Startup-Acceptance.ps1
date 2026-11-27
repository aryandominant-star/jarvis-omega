# J.A.R.V.I.S. startup acceptance tests (spec section 22) — run on a real Windows PC after installing.
#   powershell -ExecutionPolicy Bypass -File Startup-Acceptance.ps1 -Phase before   # then restart / shut down
#   powershell -ExecutionPolicy Bypass -File Startup-Acceptance.ps1 -Phase after    # after signing back in
param([ValidateSet("before", "after", "crash", "disable", "offline")] [string]$Phase = "after")
$ErrorActionPreference = "Stop"
$app = "$env:LOCALAPPDATA\Programs\JARVIS"
$node = "$app\runtime\node.exe"; $agent = "$app\app\agent.cjs"
$logs = "$env:APPDATA\JARVIS\logs"
function Pass($m) { Write-Host "PASS  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "FAIL  $m" -ForegroundColor Red; $script:failed = $true }
function Status { try { (& $node $agent status 2>$null) | ConvertFrom-Json } catch { $null } }

switch ($Phase) {
  "before" {
    if ((& $node $agent startup status) -eq "enabled") { Pass "startup task registered and enabled" } else { Fail "startup task not enabled" }
    Get-Date -Format o | Set-Content "$env:TEMP\jarvis-acceptance-before.txt"
    Write-Host "Now: restart (TEST 1), or shut down fully and power on (TEST 2), or sign out/in. Then run -Phase after."
  }
  "after" {
    $s = Status
    if ($s) { Pass "TEST 1/2: agent started automatically (pid running, version $($s.version))" } else { Fail "agent not running after sign-in" }
    $consoles = Get-Process conhost, cmd, powershell, pwsh -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -gt (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.AddMinutes(-1) -and $_.StartTime -lt (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.AddMinutes(5) }
    if (-not $consoles) { Pass "TEST 3: no visible console windows from startup" } else { Fail "TEST 3: visible console windows: $($consoles.ProcessName -join ', ')" }
    $fg = (Get-Process | Where-Object { $_.MainWindowTitle -like "*JARVIS*" })
    if (-not $fg) { Pass "TEST 4: dashboard did not open / no focus stolen" } else { Fail "TEST 4: a JARVIS window opened" }
    $toasts = (Select-String -Path "$logs\agent.log" -Pattern "\[toast\]|Starting worker" -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "INFO  TEST 5: confirm you saw exactly ONE 'JARVIS is online' notification."
    if ($s -and $s.connected) { Pass "TEST 6/7: connected to the control plane (check the dashboard shows this PC online)" } else { Fail "not connected" }
  }
  "crash" {
    $w = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*agent.cjs*--worker*" }
    if (-not $w) { Fail "worker not found"; break }
    Stop-Process -Id $w.ProcessId -Force; Start-Sleep 15
    if (Status) { Pass "TEST 8: worker restarted after crash" } else { Fail "TEST 8: no recovery" }
    $crashes = (Get-Content "$env:APPDATA\JARVIS\state.json" | ConvertFrom-Json).crashes.Count
    Write-Host "INFO  crash counter = $crashes (safe mode at 4 within 10 min, supervisor stops at 6 — no infinite loop)"
  }
  "disable" {
    & $node $agent startup disable | Out-Null
    if ((& $node $agent startup status) -eq "disabled") { Pass "TEST 9: startup disabled — restart and confirm JARVIS does not launch; then run 'startup enable'" } else { Fail "TEST 9" }
  }
  "offline" {
    Write-Host "TEST 12: disconnect the network, restart, sign in, then run -Phase after: agent should be running (connected=false),"
    Write-Host "         tray gray 'Offline — reconnecting', and it reconnects by itself when the network returns."
  }
}
Write-Host "TEST 10 (uninstall): run Settings → Apps → J.A.R.V.I.S. → Uninstall, then: schtasks /Query /TN `"JARVIS OMEGA\Agent`" must fail."
Write-Host "TEST 11 (locked): lock the PC (Win+L) and send 'open notepad' — the task must refuse to touch the desktop."
Write-Host "TEST 13 (privacy): startup only sends heartbeat metrics; files/credentials are never uploaded (see agent.log)."
if ($failed) { exit 1 }
