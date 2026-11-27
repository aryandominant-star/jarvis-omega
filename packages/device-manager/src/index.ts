// Authenticated, outbound-only connection from this PC to the control plane.
// Every request is HMAC-signed with the device secret and a strictly increasing timestamp per channel.
import crypto from "node:crypto";
import type { AgentSyncRequest, AgentSyncResponse, AgentTaskUpdate } from "../../shared-types/src/index";

export class CloudError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

class Channel {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  nextTs() {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export class CloudClient {
  private sync = new Channel();
  private req = new Channel();
  clockOffset = 0;

  constructor(public baseUrl: string, private deviceId: string, private secret: string, private timeoutMs = 35_000) {}

  private async call<T>(channel: Channel, method: string, pathname: string, body?: unknown, timeout = this.timeoutMs): Promise<T> {
    return channel.run(async () => {
      const text = body === undefined ? "" : JSON.stringify(body);
      const ts = channel.nextTs() + this.clockOffset;
      const bodyHash = crypto.createHash("sha256").update(text).digest("hex");
      const sig = crypto.createHmac("sha256", this.secret).update(`${method}\n${pathname}\n${ts}\n${bodyHash}`).digest("hex");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(this.baseUrl.replace(/\/$/, "") + pathname, {
          method,
          headers: {
            "content-type": "application/json",
            "x-jarvis-device": this.deviceId,
            "x-jarvis-timestamp": String(ts),
            "x-jarvis-signature": sig,
          },
          body: text || undefined,
          signal: ctrl.signal,
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (data.code === "clock_skew" && res.headers.get("date")) {
            // Correct for a wrong PC clock using the server's Date header; the next request will succeed.
            this.clockOffset = Date.parse(res.headers.get("date")!) - Date.now();
          }
          throw new CloudError(res.status, data.error || `HTTP ${res.status}`, data.code);
        }
        return data as T;
      } catch (e: any) {
        if (e instanceof CloudError) throw e;
        throw new CloudError(0, e.name === "AbortError" ? "Request timed out" : `Network error: ${e.message}`);
      } finally {
        clearTimeout(t);
      }
    });
  }

  syncOnce(body: AgentSyncRequest) {
    return this.call<AgentSyncResponse>(this.sync, "POST", "/api/agent/sync", body);
  }
  updateTask(taskId: string, update: AgentTaskUpdate) {
    return this.call<{ ok: boolean }>(this.req, "POST", `/api/agent/tasks/${encodeURIComponent(taskId)}/update`, update, 20_000);
  }
  command(text: string) {
    return this.call<{ task: { id: string }; routedTo: string[]; reason: string }>(this.req, "POST", "/api/agent/command", { text }, 20_000);
  }
  unpair() {
    return this.call<{ ok: boolean }>(this.req, "POST", "/api/agent/unpair", {}, 15_000);
  }
}

export async function pair(baseUrl: string, code: string, name: string, os: string, agentVersion: string, localCeiling: unknown) {
  const res = await fetch(baseUrl.replace(/\/$/, "") + "/api/agent/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name, os, agentVersion, localCeiling }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new CloudError(res.status, data.error || `Pairing failed (HTTP ${res.status})`, data.code);
  return data as { deviceId: string; deviceSecret: string; deviceName: string };
}
