// Builds the Worker bundle. `--api-only` replaces the embedded dashboard with an empty asset map.
import { build } from "esbuild";
const apiOnly = process.argv.includes("--api-only");
await build({
  entryPoints: ["src/index.ts"], bundle: true, format: "esm", target: "es2022", platform: "neutral",
  minify: true, outfile: apiOnly ? "dist/worker-api.js" : "dist/worker.js", conditions: ["workerd", "worker", "browser"],
  plugins: apiOnly ? [{ name: "no-static", setup(b) {
    b.onResolve({ filter: /\/static$/ }, () => ({ path: "static", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const ASSETS = {};", loader: "js" }));
  } }] : [],
});
