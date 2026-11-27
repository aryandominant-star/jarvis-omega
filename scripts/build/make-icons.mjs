// Generates the tray/status icons (PNG + ICO) procedurally — no binary assets in the repo.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function ico(pngs) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const dir = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12); offset += data.length; return e;
  });
  return Buffer.concat([header, ...dir, ...pngs.map((p) => p.data)]);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** Glowing ring + core, the JARVIS mark. */
function mark(color, opts = {}) {
  const [r, g, b] = hex(color);
  return (x, y, s) => {
    const cx = s / 2, d = Math.hypot(x - cx, y - cx) / (s / 2);
    const ring = Math.max(0, 1 - Math.abs(d - 0.78) / 0.1);
    const core = d < (opts.bigCore ? 0.42 : 0.34) ? 1 : Math.max(0, 1 - (d - 0.34) / 0.08);
    const glow = Math.max(0, 1 - d) * 0.35;
    const a = Math.min(1, ring + core + glow);
    const dot = opts.dot && Math.hypot(x - s * 0.8, y - s * 0.2) < s * 0.16 ? 1 : 0;
    if (dot) return [...hex(opts.dot), 255];
    return [r, g, b, Math.round(a * 255)];
  };
}
export function makeIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const variants = {
    connected: mark("#00e5ff"),
    disconnected: mark("#7a8a99"),
    attention: mark("#ffb547", { dot: "#ffb547" }),
    busy: mark("#5cf2ff", { bigCore: true, dot: "#ffffff" }),
  };
  for (const [name, fn] of Object.entries(variants)) {
    const imgs = [16, 24, 32, 48, 256].map((size) => ({ size, data: png(size, fn) }));
    fs.writeFileSync(path.join(dir, `tray-${name}.ico`), ico(imgs));
    fs.writeFileSync(path.join(dir, `tray-${name}.png`), imgs[2].data);
  }
  fs.writeFileSync(path.join(dir, "jarvis.png"), png(256, mark("#00e5ff")));
  fs.writeFileSync(path.join(dir, "jarvis.ico"), ico([16, 32, 48, 256].map((size) => ({ size, data: png(size, mark("#00e5ff")) }))));
}
if (process.argv[1]?.endsWith("make-icons.mjs")) makeIcons(process.argv[2] ?? "dist/icons");
