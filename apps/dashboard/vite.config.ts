import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: dashboardRoot,
  build: {
    outDir: "dist"
  },
  server: {
    host: "0.0.0.0",
    port: 3000
  }
});
