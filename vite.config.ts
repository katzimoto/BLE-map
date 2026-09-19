import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    sourcemap: false,
    rollupOptions: {
      // Vite warns about dynamic-worker URLs used with `new URL(…, import.meta.url)`.
      // Suppress the warning; we intentionally use the URL-constructor pattern for
      // zero-config worker bundling.
      onwarn(warning, warn) {
        if (
          warning.code === "UNRESOLVED_IMPORT" &&
          String(warning.message).includes("worker")
        )
          return;
        warn(warning);
      },
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
