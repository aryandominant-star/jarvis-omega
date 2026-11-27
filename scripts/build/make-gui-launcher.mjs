// Creates jarvisw.exe: a copy of node.exe whose PE subsystem is set to WINDOWS_GUI (2), so the agent
// starts at sign-in with no console window flashing. (Same technique as pythonw.exe vs python.exe.)
import fs from "node:fs";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error("usage: make-gui-launcher.mjs node.exe jarvisw.exe"); process.exit(2); }
const buf = fs.readFileSync(src);
if (buf.toString("ascii", 0, 2) !== "MZ") throw new Error("not a PE file");
const pe = buf.readUInt32LE(0x3c);
if (buf.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("PE header not found");
const optional = pe + 24;
const magic = buf.readUInt16LE(optional);
if (magic !== 0x20b && magic !== 0x10b) throw new Error("unexpected optional header");
const subsystemOffset = optional + 68; // same offset for PE32 and PE32+
const before = buf.readUInt16LE(subsystemOffset);
buf.writeUInt16LE(2, subsystemOffset);
fs.writeFileSync(dst, buf);
console.log(`${dst}: subsystem ${before} -> 2 (GUI)`);
