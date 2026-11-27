# Security & permissions

## Accounts
- Usernames are 3–32 characters, case-insensitive and unique. Passwords need 10+ characters and three character
  classes, and may not contain the username.
- Passwords are stored as PBKDF2-SHA256 with a per-user salt. Wrong-password responses take the same time whether or
  not the user exists. Rate limits apply per IP and per username, and an account locks for 15 minutes after 8 failures.
- Session tokens are 256-bit random values; only their SHA-256 is stored. They expire after 7 days. "Sign out
  everywhere" exists, and changing the password signs out every other session.
- Every account is isolated: devices, tasks, workflows and logs are always queried by user ID.

## Devices
- Pairing uses one-time 8-character codes that expire after 10 minutes, stored hashed and consumed atomically.
- Every agent request is HMAC-SHA256 signed: `METHOD \n PATH \n TIMESTAMP \n SHA256(body)`. Timestamps must be within
  5 minutes and strictly increasing per channel (replay protection). Device secrets are AES-GCM encrypted at rest
  with `MASTER_KEY`, and DPAPI-encrypted on the PC.
- Connections are outbound only. There is no inbound port and no remote-shell endpoint.
- Revoke works immediately: the agent's next request gets 403, and the agent wipes its secret.

## What JARVIS may do on a PC
`%APPDATA%\JARVIS\policy.json` on each PC is the **ceiling**. The permissions you set in the dashboard are
intersected with it, so the cloud can narrow access but never widen it:

| Setting | Enforced by |
|---|---|
| Approved directories | Codex sandbox `workspace-write` with `writable_roots`, plus jarvis tools path checks |
| Allowed apps | `launch_app` tool |
| Browser domains | Playwright `--allowed-origins` and `vault_fill_login` domain check |
| Commands | Only names defined in the local policy (`commands: [{ name, command, args, cwd }]`) |
| Network inside the code sandbox | off unless both sides allow it |
| Autonomy | `routine` (default) or `confirm-all`. Local `forceConfirmAll` overrides the cloud |

**Always confirmed, whatever the autonomy setting:** payments, purchases, sending messages, exporting
credentials, bulk or irreversible deletion, sharing files outside approved places, installing software, and
changing security settings. These go through `request_confirmation`, which shows Approve/Deny in the dashboard and
sends a toast on the PC. No answer within 15 minutes counts as Deny.

Honest limit: website actions like "buy" happen in the browser, and the agent relies on the model calling
`request_confirmation` before them. The persona instructions require it on every task, and the trace shows every
step. Keep `browserDomains` tight for sites that hold money.

## Credentials
Credentials are stored in a DPAPI vault (CurrentUser) and added only through the local page at `127.0.0.1`. That page
is protected by a token and a Host check and is opened from the tray. `vault_fill_login` types the username and
password into the open HTTPS page over CDP. The secret never enters the model's context, the logs (they're redacted)
or the cloud. JARVIS never bypasses MFA or CAPTCHA: it asks you instead.

## Untrusted content
Web pages, documents and emails are treated as data, never as instructions. Background workflows run only when you
create them in the dashboard; nothing a website says can create one.
