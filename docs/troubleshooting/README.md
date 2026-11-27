# Troubleshooting

| Symptom | Fix |
|---|---|
| Tray icon amber, "Connect Codex to run tasks" | Tray → *Connect Codex (ChatGPT sign-in)…* and finish the browser sign-in. |
| Tray "Not paired" | Dashboard → Devices → *Generate pairing code*, then tray → *Pair this PC…* |
| Gray icon "Offline — reconnecting" | Check internet. The agent backs off up to 5 min (10 min on battery) and reconnects by itself. |
| "Clock skew too large" in logs | Fix the PC's time (Settings → Time → Sync now). The agent also self-corrects using the server clock. |
| Codex fails with a sandbox error on Windows | Set `"codexSandbox": "read-only"` in `%APPDATA%\JARVIS\policy.json` to test, or update Windows / Codex. |
| Voice not working | Install an English speech pack: Settings → Time & language → Speech. Then tray → *Voice Assistant*. |
| Sign-in fails with Cloudflare error 1102 | Free-tier CPU limit hit by password hashing. See docs/deployment ("Free-tier budget"). |
| Safe mode | The agent crashed repeatedly. Check `%APPDATA%\JARVIS\logs\agent.log`, then Exit and restart from the Start menu. |

Logs: `%APPDATA%\JARVIS\logs\` (rotated, secrets redacted). CLI: `"%LOCALAPPDATA%\Programs\JARVIS\runtime\node.exe" "%LOCALAPPDATA%\Programs\JARVIS\app\agent.cjs" status`
