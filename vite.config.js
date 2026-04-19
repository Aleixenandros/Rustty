import { defineConfig } from "vite";

// Configuración de Vite optimizada para Tauri 2
// https://tauri.app/start/frontend/vite/
export default defineConfig({
  // Evita que Vite limpie el terminal en dev (mejor legibilidad de logs de Rust)
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    watch: {
      // Ignorar cambios en el core Rust para evitar reloads innecesarios
      ignored: ["**/src-tauri/**"],
    },
  },

  // Exponer variables de entorno de Tauri al frontend
  envPrefix: [
    "VITE_",
    "TAURI_ENV_*",
    "TAURI_PLATFORM",
    "TAURI_ARCH",
    "TAURI_FAMILY",
    "TAURI_PLATFORM_VERSION",
  ],

  build: {
    // Targets modernos según la plataforma objetivo.
    // safari16 soporta destructuring y demás sintaxis que usa xterm@6.
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari16",
    // Sin minificación en debug para mejor debugging
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Tauri usa archivos, no servidor; ajustamos las rutas
    assetsDir: "assets",
  },
});
