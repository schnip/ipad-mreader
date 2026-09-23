import { defineConfig } from "vite";

const buildNumber = new Date().toISOString().replaceAll(/\D/g, "").slice(0, 14);

export default defineConfig({
  base: "./",
  define: {
    __BUILD_NUMBER__: JSON.stringify(buildNumber)
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
});
