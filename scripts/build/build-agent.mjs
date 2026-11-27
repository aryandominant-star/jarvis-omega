// Bundles the Windows agent into dist/app/agent.cjs (+ voice script + tray icons).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeIcons } from "./make-icons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "dist", "app");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "assets"), { recursive: true });
await build({
  entryPoints: [path.join(root, "apps/windows-agent/src/main.ts")],
  bundle: true, platform: "node", target: "node22", format: "cjs", minify: false, sourcemap: false,
  outfile: path.join(out, "agent.cjs"),
  // Shipped as real node_modules next to agent.cjs (they contain native helper binaries).
  external: ["systray2", "node-notifier", "playwright-core", "docx", "node:sqlite"],
  logLevel: "warning",
});
fs.copyFileSync(path.join(root, "packages/voice-engine/src/voice.ps1"), path.join(out, "voice.ps1"));
makeIcons(path.join(out, "assets"));
// Runtime dependencies installed into dist/app/node_modules by the Windows build.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "apps/windows-agent/package.json"), "utf8"));
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({ name: "jarvis-agent-runtime", version: pkg.version, private: true, dependencies: pkg.dependencies }, null, 2));
console.log(`Agent bundle → ${path.relative(root, out)}`);
