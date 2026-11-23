import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  return {
    base: env.VITE_BASE_PATH || "/",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": { target: "http://127.0.0.1:3000", changeOrigin: true },
        "/health": { target: "http://127.0.0.1:3000", changeOrigin: true },
      },
    },
  };
});
