import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "imon-public-embed-sdk",
      generateBundle() {
        for (const file of ["embed.js", "embed-protocol.js", "index.js"])
          this.emitFile({
            type: "asset",
            fileName: `sdk/v1/${file}`,
            source: readFileSync(
              new URL(`../../packages/sdk/${file}`, import.meta.url),
              "utf8",
            ),
          });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3540", changeOrigin: false } },
  },
  build: { sourcemap: false },
});
