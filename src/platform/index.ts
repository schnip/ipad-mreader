// `@mreader/platform` is resolved at build time by vite.config.ts to either
// ./web.ts (default) or ./native.ts (`--mode android` / `--mode ios`). Only the selected file
// is ever part of the module graph, so Capacitor never enters the PWA bundle.
export { platform } from "@mreader/platform";
export type { Platform } from "./types";
