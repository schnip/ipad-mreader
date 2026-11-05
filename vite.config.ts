/// <reference types="vitest/config" />
import { readdir, readFile, writeFile } from "node:fs/promises";
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

// pdf.js loads these at runtime: `wasm/` holds the JPEG 2000 (JPX) decoder,
// without which pages built from JPX scans render blank; the others provide
// standard fonts, CJK CMaps, and the CMYK ICC profile. They are served under
// `pdfjs/` in dev and emitted into the bundle at build time, so the service
// worker precaches them like any other emitted file.
const PDFJS_ROOT = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
const PDFJS_ASSET_DIRS = ["wasm", "standard_fonts", "cmaps", "iccs"];

function pdfjsAssets(): Plugin {
  return {
    name: "mreader-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (request, response, next) => {
        const [dir, file, ...rest] = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").split("/").filter(Boolean);
        if (!dir || !file || rest.length > 0 || !PDFJS_ASSET_DIRS.includes(dir) || file.startsWith(".")) {
          next();
          return;
        }
        readFile(join(PDFJS_ROOT, dir, file)).then((data) => {
          if (file.endsWith(".wasm")) response.setHeader("Content-Type", "application/wasm");
          else if (file.endsWith(".js")) response.setHeader("Content-Type", "text/javascript");
          response.end(data);
        }, () => next());
      });
    },
    async generateBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        for (const file of await readdir(join(PDFJS_ROOT, dir))) {
          if (file.startsWith("LICENSE")) continue;
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${file}`, source: await readFile(join(PDFJS_ROOT, dir, file)) });
        }
      }
    }
  };
}

// Capacitor shells. Each bundles its assets, so none registers a service worker.
const NATIVE_MODES = new Set(["android", "ios"]);

// Build-time platform selection. Only the aliased file joins the module graph,
// so only the native modes (`--mode android`, `--mode ios`) can ever reach
// Capacitor imports.
function platformModule(mode: string): string {
  const file = NATIVE_MODES.has(mode) ? "./src/platform/native.ts" : "./src/platform/web.ts";
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
    pdfjsAssets(),
    serviceWorkerManifest(),
    {
      name: "mreader-build-number",
      apply: "build",
      closeBundle() {
        if (!NATIVE_MODES.has(mode)) console.log(`mreader service-worker cache mreader-p6-${buildNumber}`);
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
