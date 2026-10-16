import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.schnip.mreader",
  appName: "mreader",
  webDir: "dist",
  backgroundColor: "#17191d",
  server: {
    // Capacitor 8's default; explicit because OPFS needs a secure context.
    androidScheme: "https"
  },
  android: {
    backgroundColor: "#17191d",
    allowMixedContent: false,
    // The reader owns pinch zoom; native WebView zoom must stay off.
    zoomEnabled: false
  }
};

export default config;
