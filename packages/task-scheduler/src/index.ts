// Local background monitors. User-defined scheduled workflows live in the cloud scheduler (cron in the
// control plane) so they survive this PC being off; these monitors only watch local health and alert.
import type { DeviceMetrics } from "../../shared-types/src/index";

export interface MonitorAlert { key: string; title: string; message: string }

export class LocalMonitors {
  private lastAlert = new Map<string, number>();
  constructor(private opts: { diskFreePercent: number; cooldownMs: number }) {}

  check(m: DeviceMetrics): MonitorAlert[] {
    const out: MonitorAlert[] = [];
    for (const d of m.disks) {
      const freePct = ((d.totalBytes - d.usedBytes) / d.totalBytes) * 100;
      if (freePct < this.opts.diskFreePercent) {
        out.push({
          key: `disk:${d.mount}`,
          title: "Low disk space",
          message: `${d.mount} has ${freePct.toFixed(1)}% free (${(Math.max(d.totalBytes - d.usedBytes, 0) / 1e9).toFixed(1)} GB).`,
        });
      }
    }
    const now = Date.now();
    return out.filter((a) => {
      const last = this.lastAlert.get(a.key) ?? 0;
      if (now - last < this.opts.cooldownMs) return false;
      this.lastAlert.set(a.key, now);
      return true;
    });
  }
}

/** True if `now` falls inside a quiet-hours window like 22:00-07:00 (local time). */
export function inQuietHours(q: { enabled: boolean; start: string; end: string }, now = new Date()): boolean {
  if (!q.enabled) return false;
  const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return (h % 24) * 60 + (m || 0); };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(q.start), b = toMin(q.end);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** Exponential backoff with jitter, capped. */
export function backoff(attempt: number, baseMs = 2000, maxMs = 5 * 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 12));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}
