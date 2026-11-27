# Deployment

## Current production

- **Worker** `jarvis-omega-control` on account `2c17abdb176c596c4aa18380995c8e55`, URL
  `https://jarvis-omega-control.jarvis-omega-2c17ab.workers.dev`, cron `* * * * *`, D1 `jarvis-omega`
  (`ed2f5f85-3987-404a-8da4-7527f83e7833`). The `MASTER_KEY` secret (which encrypts device keys at rest) was
  generated inside Cloudflare and has never been stored anywhere else.
- **Dashboard** built by GitHub Actions to GitHub Pages. The Worker serves it from its own origin by proxying
  `DASHBOARD_ORIGIN`, so the command center and the API share one address.
- **Installer** built on `windows-latest` by the `windows` job, then smoke-tested: silent install, startup task
  registered, agent running, uninstall removes everything.

## Automatic Worker deploys (optional)

The `worker` job deploys the control plane on every push to `main` once a token exists:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → *Edit Cloudflare Workers* template, and add
   **Account · D1 · Edit**. Limit it to your account.
2. GitHub repo → Settings → Secrets and variables → Actions → New secret `CLOUDFLARE_API_TOKEN`.

Without the token, deploy by hand: `cd apps/cloud-control-plane && npx wrangler deploy`.

## Free-tier budget

Workers Free allows 100k requests/day and 10 ms CPU per request; D1 Free allows 100k rows written/day.
- Each PC holds a 20-second long-poll, which comes to about 4,300 requests/day per PC. That's comfortably 15–20 PCs.
- Password hashing (PBKDF2-SHA256, 100k iterations) is the only CPU-heavy operation. If sign-ins fail with error
  1102 (CPU exceeded), either move to Workers Paid ($5/mo, recommended) or set the `PBKDF2_ITER` var lower.
  Accounts store their own iteration count, so existing users keep working.

## Hosting the dashboard elsewhere (e.g. InfinityFree)

`VITE_API_URL=https://<worker-url> npm -w @jarvis/web-dashboard run build`, upload `apps/web-dashboard/dist/`
(includes `.htaccess`), and add your site's origin to `ALLOWED_ORIGINS` in `wrangler.toml`.

## Closing sign-ups

Set `ALLOW_REGISTRATION = "false"`, or keep it open but require an invite: `wrangler secret put REGISTRATION_INVITE_CODE`.
