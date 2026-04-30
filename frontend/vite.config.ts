import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  preview: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 700,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
});
