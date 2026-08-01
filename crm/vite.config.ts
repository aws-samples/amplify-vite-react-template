/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom so hooks and components can be rendered without a browser.
    environment: "jsdom",
    // No implicit globals: tests import `describe`/`it`/`expect` from "vitest".
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // Tests live beside the code they cover, under src/.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
