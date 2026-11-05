import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.schnip.mreader",
  appName: "mreader",
  webDir: "dist",
  backgroundColor: "#ac193d",
  server: {
    // Capacitor 8's default; explicit because OPFS needs a secure context.
    androidScheme: "https"
  },
  android: {
    backgroundColor: "#ac193d",
    allowMixedContent: false,
    // The reader owns pinch zoom; native WebView zoom must stay off.
    zoomEnabled: false
  },
  ios: {
    backgroundColor: "#ac193d",
    // The reader owns pinch zoom, panning and rubber-banding; WKWebView's own
    // scroll view must neither scroll, bounce nor zoom underneath it.
    zoomEnabled: false,
    scrollEnabled: false,
    // Safe areas are handled in CSS via env(safe-area-inset-*), as in the PWA.
    contentInset: "never",
    // Long-press belongs to custom text selection, not native link previews.
    allowsLinkPreview: false
  }
};

export default config;
