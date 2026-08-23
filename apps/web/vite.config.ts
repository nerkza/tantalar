import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.TANTALAR_API ?? "http://127.0.0.1:3199", changeOrigin: true },
    },
  },
  test: undefined,
});
