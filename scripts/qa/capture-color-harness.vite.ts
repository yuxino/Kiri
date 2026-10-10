import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { entries: ["scripts/qa/capture-color-harness.html"] },
  server: { host: "127.0.0.1", port: 5190, strictPort: true },
});
