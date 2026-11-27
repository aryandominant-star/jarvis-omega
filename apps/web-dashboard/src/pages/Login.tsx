import { useEffect, useState, type FormEvent } from "react";
import { Api } from "../api";
import { useAuth } from "../auth";

function strength(pw: string) {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  return s;
}

export function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [invite, setInvite] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<{ registration: boolean; inviteRequired: boolean } | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    Api.health().then((h) => { setServer(h); setOnline(true); }).catch(() => setOnline(false));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "up" && password !== confirmPw) return setError("Passwords do not match");
    setBusy(true);
    try {
      if (mode === "in") await signIn(username, password, remember);
      else await signUp(username, password, remember, invite || undefined);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const s = strength(password);
  const colors = ["#ff5d6c", "#ff5d6c", "#ffb547", "#ffb547", "#36f1a5", "#00e5ff"];

  return (
    <>
      <div className="bg-layer bg-login" />
      <div className="grid-overlay" />
      <div className="login-wrap">
        <div className="login-side">
          <h1 className="login-title">J.A.R.V.I.S.<small>OMEGA · COMMAND CENTER</small></h1>
          <div className="panel login-card">
            <div className="tabs">
              <button className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setError(null); }}>Sign in</button>
              <button className={mode === "up" ? "on" : ""} onClick={() => { setMode("up"); setError(null); }} disabled={server?.registration === false}>Create account</button>
            </div>
            <form onSubmit={submit}>
              {error && <div className="error-box">{error}</div>}
              <div className="field">
                <label htmlFor="u">Username</label>
                <input id="u" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. alex.morgan" required minLength={3} maxLength={32} autoFocus />
              </div>
              <div className="field">
                <label htmlFor="p">Password</label>
                <input id="p" className="input" type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "up" ? 10 : 1} />
                {mode === "up" && <div className="strength"><i style={{ width: `${(s / 5) * 100}%`, background: colors[s] }} /></div>}
              </div>
              {mode === "up" && (
                <>
                  <div className="field">
                    <label htmlFor="p2">Confirm password</label>
                    <input id="p2" className="input" type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required />
                  </div>
                  {server?.inviteRequired && (
                    <div className="field">
                      <label htmlFor="inv">Invite code</label>
                      <input id="inv" className="input" value={invite} onChange={(e) => setInvite(e.target.value)} required />
                    </div>
                  )}
                  <p className="note" style={{ marginTop: -4 }}>At least 10 characters with three of: lowercase, uppercase, numbers, symbols.</p>
                </>
              )}
              <div className="row" style={{ justifyContent: "space-between", margin: "6px 0 18px" }}>
                <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in on this device</label>
              </div>
              <button className="btn" style={{ width: "100%", padding: 14 }} disabled={busy || online === false}>
                {busy ? "Authenticating…" : mode === "in" ? "Sign in" : "Create account"}
              </button>
            </form>
          </div>
          <div className="login-foot">
            <span className={`dot ${online ? "ok" : online === false ? "bad" : ""}`} style={{ display: "inline-block", marginRight: 8 }} />
            {online === null ? "Contacting control plane…" : online ? "Control plane online · encrypted connection" : "Control plane unreachable"}
            <br />Every account has its own devices, tasks and memory. Nothing is visible without signing in.
          </div>
        </div>
        <div />
      </div>
    </>
  );
}
