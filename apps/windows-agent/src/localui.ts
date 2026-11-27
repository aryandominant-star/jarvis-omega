// Local-only settings page (127.0.0.1, random port, random token). Used for things that must never pass
// through the cloud: adding credentials to the DPAPI vault, and pairing this PC with a one-time code.
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import { pair } from "../../../packages/device-manager/src/index";
import type { Agent } from "./agent";
import { loadConfig, saveConfig, saveDeviceSecret } from "./core/config";
import { AGENT_VERSION } from "./core/paths";

const PAGE = (token: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>J.A.R.V.I.S. — This PC</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(1000px 600px at 70% 10%,#0c2140,#03060d 70%);color:#dcf6ff;font:15px "Segoe UI",system-ui,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:40px 24px}h1{letter-spacing:.3em;font-weight:700;margin:0}h1 small{display:block;color:#00e5ff;font-size:12px;letter-spacing:.5em;margin-top:6px}
.card{border:1px solid rgba(0,229,255,.2);border-radius:14px;padding:22px;margin-top:22px;background:linear-gradient(160deg,rgba(14,30,52,.7),rgba(6,12,22,.7))}
.card h2{margin:0 0 14px;font-size:12px;letter-spacing:.3em;color:#7df3ff;text-transform:uppercase}
input{width:100%;padding:11px 13px;border-radius:9px;border:1px solid rgba(0,229,255,.2);background:#030a14;color:#e8fbff;margin:6px 0 12px;font:inherit}
input:focus{outline:none;border-color:#00e5ff}label{font-size:11px;letter-spacing:.2em;color:#7d98aa;text-transform:uppercase}
button{cursor:pointer;padding:10px 16px;border-radius:9px;border:1px solid rgba(0,229,255,.45);background:rgba(0,229,255,.12);color:#9ff8ff;font-weight:600;letter-spacing:.12em;text-transform:uppercase;font-size:12px}
button.del{border-color:rgba(255,93,108,.5);background:rgba(255,93,108,.1);color:#ffc2c8}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px dashed rgba(0,229,255,.12)}
.mono{font-family:Consolas,monospace;color:#7d98aa;font-size:13px}.msg{margin-top:10px;font-size:14px}.ok{color:#36f1a5}.bad{color:#ff8a95}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
</style></head><body><div class="wrap">
<h1>J.A.R.V.I.S.<small>THIS PC · ${os.hostname()} · AGENT ${AGENT_VERSION}</small></h1>
<div class="card" id="pair"><h2>Pair this PC</h2><div id="pstate" class="mono"></div>
<label>Dashboard / control plane URL</label><input id="url" placeholder="https://jarvis-omega-control.….workers.dev">
<div class="grid"><div><label>Pairing code (from Devices page)</label><input id="code" placeholder="ABCD-EFGH"></div>
<div><label>Device name</label><input id="name" value="${os.hostname().toUpperCase()}"></div></div>
<button onclick="doPair()">Pair</button><div id="pmsg" class="msg"></div></div>
<div class="card" id="vault"><h2>Credential vault</h2>
<p class="mono">Encrypted with Windows DPAPI for your Windows account. Passwords never leave this PC and are never shown to the AI — JARVIS types them straight into the login page.</p>
<div id="list"></div>
<div class="grid" style="margin-top:14px"><div><label>Website domain</label><input id="d" placeholder="github.com"></div><div><label>Username / email</label><input id="u" autocomplete="off"></div></div>
<label>Password</label><input id="p" type="password" autocomplete="new-password"><button onclick="add()">Save credential</button><div id="vmsg" class="msg"></div></div>
</div><script>
const T=${JSON.stringify(token)};
async function call(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-jarvis-token':T,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function load(){try{const s=await call('/api/state');document.getElementById('pstate').textContent=s.paired?('Paired as '+s.name+' · '+s.apiUrl):'Not paired';if(s.apiUrl)document.getElementById('url').value=s.apiUrl;
const v=await call('/api/vault');document.getElementById('list').innerHTML=v.items.length?v.items.map(i=>'<div class="row"><span>'+esc(i.domain)+' <span class="mono">· '+esc(i.username)+'</span></span><button class="del" onclick="del(\\''+esc(i.domain)+'\\',\\''+esc(i.username)+'\\')">Remove</button></div>').join(''):'<p class="mono">No saved credentials.</p>'}catch(e){document.getElementById('vmsg').innerHTML='<span class="bad">'+esc(e.message)+'</span>'}}
async function add(){const m=document.getElementById('vmsg');try{await call('/api/vault/add',{domain:d.value,username:u.value,password:p.value});p.value='';m.innerHTML='<span class="ok">Saved.</span>';load()}catch(e){m.innerHTML='<span class="bad">'+esc(e.message)+'</span>'}}
async function del(domain,username){await call('/api/vault/remove',{domain,username});load()}
async function doPair(){const m=document.getElementById('pmsg');m.textContent='Pairing…';try{const r=await call('/api/pair',{url:url.value,code:code.value,name:name.value});m.innerHTML='<span class="ok">Paired as '+esc(r.deviceName)+'. JARVIS is connecting.</span>';load()}catch(e){m.innerHTML='<span class="bad">'+esc(e.message)+'</span>'}}
load();
</script></body></html>`;

export function startLocalUi(agent: Agent): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    // Defend against DNS rebinding and cross-site requests.
    const host = req.headers.host ?? "";
    if (!/^127\.0\.0\.1:\d+$/.test(host)) return send(403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/") {
      if (url.searchParams.get("t") !== token) return send(403, "Open this page from the JARVIS tray menu.", "text/plain");
      return send(200, PAGE(token), "text/html; charset=utf-8");
    }
    if (req.headers["x-jarvis-token"] !== token) return send(403, { error: "forbidden" });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(403, { error: "forbidden" });
    let body: any = {};
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) { chunks.push(c as Buffer); if (chunks.reduce((n, b) => n + b.length, 0) > 20000) return send(413, { error: "too large" }); }
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return send(400, { error: "bad json" }); }
    }
    try {
      if (url.pathname === "/api/state") return send(200, { paired: !!agent.cfg.deviceId, name: agent.cfg.deviceName, apiUrl: agent.cfg.apiUrl });
      if (url.pathname === "/api/vault") return send(200, { items: await agent.vault.list() });
      if (url.pathname === "/api/vault/add") { await agent.vault.upsert(String(body.domain ?? ""), String(body.username ?? ""), String(body.password ?? "")); return send(200, { ok: true }); }
      if (url.pathname === "/api/vault/remove") { await agent.vault.remove(String(body.domain ?? ""), body.username ? String(body.username) : undefined); return send(200, { ok: true }); }
      if (url.pathname === "/api/pair") {
        const apiUrl = String(body.url ?? "").trim().replace(/\/(#.*)?$/, "");
        if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(apiUrl)) throw new Error("Use the https:// address of your JARVIS control plane");
        const r = await pair(apiUrl, String(body.code ?? ""), String(body.name ?? os.hostname()), `${os.type()} ${os.release()}`, AGENT_VERSION, agent.policy);
        await saveDeviceSecret(r.deviceSecret);
        const cfg = { ...loadConfig(), apiUrl, dashboardUrl: apiUrl, deviceId: r.deviceId, deviceName: r.deviceName };
        saveConfig(cfg);
        agent.cfg = cfg; agent.client = null; agent.tray.setPaired(true);
        return send(200, { ok: true, deviceName: r.deviceName });
      }
      return send(404, { error: "not found" });
    } catch (e: any) {
      return send(400, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve(`http://127.0.0.1:${port}/?t=${token}`);
    });
  });
}
