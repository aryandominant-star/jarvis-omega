import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_API_URL: the Cloudflare Worker URL, e.g. https://jarvis-omega-control.<you>.workers.dev
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: { port: 5173 },
});
