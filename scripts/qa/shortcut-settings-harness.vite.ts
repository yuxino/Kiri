import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

// Separate entry/config: no QA route or mock imports enter the app build.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {entries: ["scripts/qa/shortcut-settings-harness.html"]},
  server: {host: "127.0.0.1", port: Number(process.env.KIRI_SHORTCUT_QA_PORT || 5199), strictPort: true,
    watch: {ignored: ["**/src-tauri/target/**"]}},
});
