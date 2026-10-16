import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const buildNumber = new Date().toISOString().replaceAll(/\D/g, "").slice(0, 14);

// Build-time platform selection. Only the aliased file joins the module graph,
// so `--mode android` is the only build that can ever reach Capacitor imports.
function platformModule(mode: string): string {
  const file = mode === "android" ? "./src/platform/native.ts" : "./src/platform/web.ts";
  return fileURLToPath(new URL(file, import.meta.url));
}

export default defineConfig(({ mode }) => ({
  base: "./",
  define: {
    __BUILD_NUMBER__: JSON.stringify(buildNumber)
  },
  resolve: {
    alias: [{ find: /^@mreader\/platform$/, replacement: platformModule(mode) }]
  },
  plugins: [
    {
      name: "mreader-build-number",
      apply: "build",
      closeBundle() {
        console.log(`mreader build ${buildNumber}`);
      }
    }
  ],
  build: {
    target: "safari15",
    sourcemap: true
  },
  server: {
    strictPort: true
  }
}));
