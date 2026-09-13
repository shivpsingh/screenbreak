/// <reference types="vitest/config" />
import { resolve } from "node:path";
import process from "node:process";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react()],

  build: {
    rollupOptions: {
      // Two entry points: the settings window and the break overlay. Keeping
      // them separate means the break window loads only what it needs and
      // cannot be affected by settings-page state.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        break: resolve(import.meta.dirname, "break.html"),
      },
    },
  },

  // Vite options tailored for Tauri development, applied under `tauri dev`
  // and `tauri build`.
  //
  // 1. Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  // 2. Tauri expects a fixed port and should fail if it is unavailable.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 3. Rust sources are watched by the Tauri CLI, not by Vite.
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
