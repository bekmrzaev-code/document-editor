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
});
