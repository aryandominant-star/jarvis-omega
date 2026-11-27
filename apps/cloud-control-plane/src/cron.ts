// Minimal 5-field cron matcher (minute hour day-of-month month day-of-week) with IANA timezone support.
// Supports: *, numbers, lists (1,2), ranges (1-5), steps (*/15, 1-30/5), and day names / month names.

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of field.toLowerCase().split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${field}"`);
    let lo: number, hi: number;
    if (rangePart === "*") [lo, hi] = [min, max];
    else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = NAMES[a] ?? parseInt(a, 10);
      hi = NAMES[b] ?? parseInt(b, 10);
    } else {
      lo = NAMES[rangePart] ?? parseInt(rangePart, 10);
      hi = stepPart ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Value out of range in "${field}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CronSpec {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  domStar: boolean; dowStar: boolean;
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("Cron expression must have 5 fields: minute hour day month weekday");
  const dow = parseField(f[4], RANGES[4]);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minute: parseField(f[0], RANGES[0]), hour: parseField(f[1], RANGES[1]), dom: parseField(f[2], RANGES[2]),
    month: parseField(f[3], RANGES[3]), dow, domStar: f[2] === "*", dowStar: f[4] === "*",
  };
}

export function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute,
    dow: NAMES[p.weekday.toLowerCase().slice(0, 3)],
  };
}

export function cronMatches(spec: CronSpec, date: Date, timeZone: string): boolean {
  const z = zonedParts(date, timeZone);
  if (!spec.minute.has(z.minute) || !spec.hour.has(z.hour) || !spec.month.has(z.month)) return false;
  const domOk = spec.dom.has(z.day);
  const dowOk = spec.dow.has(z.dow);
  // Standard cron semantics: if both day fields are restricted, either may match.
  if (!spec.domStar && !spec.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
