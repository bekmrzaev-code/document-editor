import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI on :5173 and proxies /api/* to the FastAPI backend (:8000).
// Build: `npm run build` → dist/, which the backend can serve in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: { outDir: "dist", emptyOutDir: true },
  // jsdom for localStorage/document in the engine's constructor; the tests
  // themselves stay clear of canvas, so no canvas backend is needed.
  test: { environment: "jsdom", include: ["src/**/*.test.js"] },
});
