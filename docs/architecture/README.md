# Architecture

## Task lifecycle
`QUEUED → PLANNING → RUNNING ⇄ WAITING_FOR_INPUT → VALIDATING → COMPLETED | FAILED | CANCELLED`
(the server rejects any other transition).

1. The dashboard, a workflow, or a voice command on a PC creates a task. The control plane routes it:
   - named device ("on my laptop") → that device
   - "all my computers" → a group task with one subtask per online device
   - "my other PC" → the other device
   - otherwise → your default device, or the most recently active one
2. The agent's long-poll returns the task. The agent records a local checkpoint in SQLite, builds the prompt
   (persona, permissions, relevant memory, recent tasks), starts or reuses its browser (headless if the desktop is
   locked), and runs `codex exec --json` with its private `CODEX_HOME` config: jarvis + Playwright MCP servers,
   live web search, and the sandbox.
3. Codex JSONL events become status changes and trace events, batched every 1.5 s. Any tool call that changes
   something marks the task as having side effects.
4. Cancel or emergency stop kills the whole process tree. Timeouts (45 min by default) do the same.
5. Crash or power loss: on restart, any task still marked `running` is reported FAILED and **never re-run**. **Retry**
   resumes the same Codex thread and tells the model to check what was already done first.

## Startup
A Task Scheduler task (per user, LeastPrivilege, InteractiveToken) triggers at logon (+15 s), on unlock, and on
resume from sleep (Power-Troubleshooter event 1). It runs `jarvisw.exe agent.cjs --background`. `jarvisw.exe` is
`node.exe` with its PE subsystem patched to GUI, so no console window ever flashes. The supervisor holds a per-user
named-pipe lock (single instance) and forks the worker:
- Restarts use backoff.
- 4 crashes within 10 minutes → safe mode (connects but runs no tasks).
- 6 crashes → the supervisor stops. No infinite loop.

The startup toast appears once per Windows sign-in, after the first successful sync, or after 60 s if offline. It
waits while you're in full screen, presentation mode or Focus Assist.

## Codex
JARVIS uses only the official CLI, via `codex login` (Sign in with ChatGPT) and `codex exec`. It never reads, copies
or forwards the tokens in `CODEX_HOME/auth.json`. `OPENAI_API_KEY`/`CODEX_API_KEY` are stripped from the environment,
so usage comes from your ChatGPT plan's Codex allowance, which has its own limits.
