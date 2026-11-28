# J.A.R.V.I.S. OMEGA

A personal AI system that operates your real Windows computers. You give it orders by voice or text from a 3D
command center in the browser. It plans with **OpenAI Codex** (signed in with your ChatGPT account), drives a real
browser with **Playwright**, opens apps, works with files in folders you approve, and reports back.

```
Browser (any device)                Cloudflare (free tier)                     Each Windows PC (per-user, no admin)
┌──────────────────────┐  HTTPS   ┌──────────────────────────────┐  HMAC-signed  ┌──────────────────────────────────────┐
│ 3D command center    │ ───────▶ │ Worker: auth, devices, tasks │ ◀── long-poll │ JARVIS agent (tray)                    │
│ username + password  │          │ scheduler, audit, e-stop     │   (outbound)  │  ├─ Codex CLI  (ChatGPT sign-in)       │
└──────────────────────┘          │ D1: users, devices, tasks…   │               │  ├─ Playwright MCP → Chrome/Edge       │
                                  └──────────────────────────────┘               │  ├─ jarvis MCP tools (apps/files/vault)│
                                                                                 │  ├─ SQLite memory · DPAPI vault        │
                                                                                 │  └─ offline “Hey Jarvis” voice         │
                                                                                 └──────────────────────────────────────┘
```

## Live deployment

| | |
|---|---|
| Command center + API | https://jarvis-omega-control.jarvis-omega-2c17ab.workers.dev |
| Dashboard (static mirror) | https://aryandominant-star.github.io/jarvis-omega/ |
| Windows installer | GitHub → Actions → latest “Build, test & ship” run → **JARVIS-Setup** artifact (or Releases for tagged versions) |

## Use it

1. Open the command center and **create an account** (username + password). Nothing is visible without signing in.
2. **Devices → one-time pairing code** (expires in 10 min, pairs one PC), or **Create enrollment code** — a reusable
   code good for 30 days that you can bake into a pre-configured installer so a PC pairs itself on first run.
3. On each PC, run **JARVIS-Setup.exe**. The wizard goes Welcome → Permissions → **Pairing** (enter the code) → Workspace
   → Browser → Voice → Cloud check → Startup → Initialization. No admin rights are needed. Startup is registered two
   ways — an HKCU *Run* entry (fires on every sign-in) and a scheduled task (also covers unlock and resume from sleep) —
   so the agent reliably comes up after the machine is switched on, and self-heals the entry on each boot.
4. On the last page keep **“Connect Codex now”** ticked and sign in with ChatGPT. You can also do this later from the
   tray menu → *Connect Codex*.
5. In the tray menu → **Credential Vault…**, add logins for sites JARVIS should sign in to. They're stored with DPAPI
   on that PC and are never sent to the cloud or shown to the AI.
6. Open a device's **Control** panel. The moment it connects, JARVIS fetches the file directory into a browsable tree
   and learns a summary of what's on the machine (stored in its local memory, so later orders know your folders). From
   here you can message the screen, run terminal commands, view the screen, control power and download/delete files.
7. Give orders: *“Jarvis, check my other PC, research the newest developments in AI, prepare a report and save it to
   my documents.”*

For a pre-built, download-and-run installer, set a repository **Actions variable** `PAIR_CODE` to a reusable enrollment
code; the published `JARVIS-Setup.exe` then pairs and starts itself with nothing to type. JARVIS speaks with a modern,
natural Windows voice (a refined British male by default) and falls back to the classic voice only if none is installed.

## What is in the box

| Path | What |
|---|---|
| `apps/cloud-control-plane` | Cloudflare Worker + D1: accounts (PBKDF2 passwords, sessions, lockout, rate limits), pairing, HMAC device auth with replay protection, task state machine, long-poll dispatch, NL device routing, approvals, emergency stop, cron workflows, audit log |
| `apps/web-dashboard` | React + Vite + Three.js / R3F. Full-screen cosmic scene: plasma core = JARVIS, planets = your PCs (live CPU/MEM arcs, beams pulse while working), bloom. Devices, tasks + approvals, workflows, memory, security log, settings, browser voice |
| `apps/windows-agent` | Supervisor (single instance, bounded crash recovery, safe mode), sync loop (backoff, sleep/resume detection, battery-aware), task engine (checkpoints, cancel, timeouts, never re-runs side effects), Codex runner, jarvis MCP server, local IPC, local vault/pairing page |
| `apps/windows-tray` | Tray icon (blue/gray/amber/busy) and the menu from the spec |
| `apps/windows-installer` | Inno Setup wizard → `JARVIS-Setup.exe`, per-user, startup task, AppUserModelID for toasts, clean uninstall |
| `packages/*` | agent-brain (Codex), permissions (local ceiling ∩ cloud), memory (SQLite), credential-vault (DPAPI), browser-controller (CDP + safe login fill), web-research (cited reports → md/html/pdf/docx), windows-automation (apps, toasts, Task Scheduler, session state), voice-engine (System.Speech), task-scheduler, device-manager, file-manager, rea-integration |
| `tests/` | Control-plane integration tests (22), agent end-to-end tests (12), Windows startup acceptance script |

## Develop

```bash
npm install
npm run dev:cloud         # Worker + local D1 on :8787 (first: cd apps/cloud-control-plane && npm run db:migrate:local)
npm run dev:web           # dashboard on :5173
node tests/integration/run.mjs
npm run build:agent && node tests/e2e/agent-e2e.mjs
```

More: [deployment](docs/deployment/README.md) · [security & permissions](docs/permissions/README.md) ·
[architecture](docs/architecture/README.md) · [troubleshooting](docs/troubleshooting/README.md)
