/// <reference types="vitest/config" />
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const buildNumber = new Date().toISOString().replaceAll(/\D/g, "").slice(0, 14);

// Stamps the build number into the service worker's cache name and gives it
// the complete list of emitted files to precache, so the first offline launch
// already has every chunk (including lazily loaded export code).
function serviceWorkerManifest(): Plugin {
  let outDir = "dist";
  return {
    name: "mreader-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async writeBundle(_options, bundle) {
      const path = join(outDir, "sw.js");
      const source = await readFile(path, "utf8").catch(() => undefined);
      if (source === undefined) return;
      const assets = Object.keys(bundle).filter((file) => !file.endsWith(".map") && file !== "index.html").sort();
      await writeFile(path, source
        .replace("__MREADER_BUILD__", buildNumber)
        .replace("[/* __MREADER_PRECACHE__ */]", JSON.stringify(assets)));
    }
  };
}

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
    serviceWorkerManifest(),
    {
      name: "mreader-build-number",
      apply: "build",
      closeBundle() {
        if (mode !== "android") console.log(`mreader service-worker cache mreader-p6-${buildNumber}`);
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
  },
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/vite-env.d.ts", "src/main.ts"]
    }
  }
}));
