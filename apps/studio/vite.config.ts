import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: process.env.TOKEN_TALK_BASE_PATH?.trim() || "/",
  server: {
    port: 4310,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4311",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    exclude: ["e2e/**", "e2e-production/**", "dist/**", "node_modules/**"],
    css: true,
    testTimeout: 30_000,
  },
});
