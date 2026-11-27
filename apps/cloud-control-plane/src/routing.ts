// Decides which enrolled device(s) a natural-language command is meant for.

export interface RoutableDevice {
  id: string;
  name: string;
  online: boolean;
  lastHeartbeat: number | null;
}

const GENERIC = new Set(["pc", "computer", "machine", "device", "my", "the", "box"]);
const ALL_RE = /\b(all|every|each)\s+(of\s+)?(my\s+)?(connected\s+|online\s+|enrolled\s+)?(computers|devices|pcs|machines|systems)\b/i;
const OTHER_RE = /\b(my\s+)?other\s+(pc|computer|machine|device|laptop|desktop)\b/i;

function tokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !GENERIC.has(t));
}

export interface RouteResult {
  deviceIds: string[];
  reason: string;
}

export function resolveDevices(
  prompt: string,
  devices: RoutableDevice[],
  opts: { defaultDeviceId: string | null; originDeviceId?: string | null }
): RouteResult {
  if (devices.length === 0) return { deviceIds: [], reason: "no devices enrolled" };
  const text = prompt.toLowerCase();

  if (ALL_RE.test(prompt)) {
    const online = devices.filter((d) => d.online);
    return { deviceIds: online.map((d) => d.id), reason: "all online devices" };
  }

  // Exact device name, with dashes/underscores read as spaces ("home laptop" == HOME-LAPTOP).
  const flat = text.replace(/[-_]/g, " ");
  const exact = devices.filter((d) => flat.includes(d.name.toLowerCase().replace(/[-_]/g, " ")));
  if (exact.length) return { deviceIds: [exact[0].id], reason: `named device ${exact[0].name}` };

  // Distinctive name tokens ("laptop", "workstation", "office").
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = devices
    .map((d) => ({ d, score: tokens(d.name).filter((t) => words.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.d.online) - Number(a.d.online));
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { deviceIds: [scored[0].d.id], reason: `matched "${scored[0].d.name}"` };
  }

  if (OTHER_RE.test(prompt) && opts.originDeviceId) {
    const others = devices.filter((d) => d.id !== opts.originDeviceId);
    const onlineOthers = others.filter((d) => d.online);
    const pick = onlineOthers.length === 1 ? onlineOthers[0] : others.length === 1 ? others[0] : null;
    if (pick) return { deviceIds: [pick.id], reason: `the other device (${pick.name})` };
  }

  if (opts.originDeviceId && devices.some((d) => d.id === opts.originDeviceId)) {
    return { deviceIds: [opts.originDeviceId], reason: "the device that heard the command" };
  }
  if (opts.defaultDeviceId && devices.some((d) => d.id === opts.defaultDeviceId)) {
    return { deviceIds: [opts.defaultDeviceId], reason: "default device" };
  }
  const best = [...devices].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastHeartbeat ?? 0) - (a.lastHeartbeat ?? 0))[0];
  return { deviceIds: [best.id], reason: `most recently active device (${best.name})` };
}
