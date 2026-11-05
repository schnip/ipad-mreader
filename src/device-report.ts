export type CheckStatus = "pending" | "pass" | "fail";

export interface DeviceCheck {
  id: string;
  title: string;
  instruction: string;
  blocking: boolean;
}

export interface CheckResult {
  status: CheckStatus;
  notes: string;
}

export interface ProbeLog {
  at: string;
  probe: string;
  message: string;
  data?: unknown;
}

export const BUILD_NUMBER = __BUILD_NUMBER__;

const STORAGE_KEY = "mreader-p0-device-results-v1";

export const deviceChecks: DeviceCheck[] = [
  {
    id: "pdf-performance",
    title: "PDF rendering and memory",
    instruction: "Open both a 500-page scan and a text-heavy PDF. Run the all-page benchmark and record responsiveness, p95 render time, and any reload/crash.",
    blocking: true
  },
  {
    id: "gesture-ownership",
    title: "Pinch and pan ownership",
    instruction: "Pinch and pan the page repeatedly. The document should move while Safari page zoom and rubber-banding remain absent.",
    blocking: true
  },
  {
    id: "opfs",
    title: "OPFS 200 MB round trip",
    instruction: "Open a roughly 200 MB PDF, run OPFS round trip, and record quota, persistence, write/read timing, and any permission prompt.",
    blocking: false
  },
  {
    id: "standalone",
    title: "Standalone and safe areas",
    instruction: "Add to Home Screen and launch there. Confirm no browser chrome and no controls hidden behind the status bar or home indicator.",
    blocking: false
  },
  {
    id: "pencil",
    title: "Pencil pressure, tilt, and latency",
    instruction: "Draw quick and slow strokes with Apple Pencil. Confirm pointerType=pen, varying pressure/tilt, variable-width ink, and that Pencil input never moves or turns the page.",
    blocking: false
  },
  {
    id: "swipe",
    title: "Finger-following swipe and navigation defense",
    instruction: "At fit scale, turn pages from the center and both screen edges. The outgoing and prefetched incoming pages must both be visible during the drag; no gesture may close, blank, or navigate the app.",
    blocking: true
  },
  {
    id: "coalesced",
    title: "Coalesced Pencil events",
    instruction: "Draw several quick Pencil curves and check whether the telemetry reports getCoalescedEvents support and samples above one.",
    blocking: false
  },
  {
    id: "selection",
    title: "Custom text selection",
    instruction: "Enable Select text, drag within and across text runs, and pinch with two fingers. Confirm character-level highlighting and handles work while custom pinch zoom remains available and native Safari zoom stays suppressed.",
    blocking: false
  }
];

export function loadResults(): Record<string, CheckResult> {
  const defaults: Record<string, CheckResult> = Object.fromEntries(
    deviceChecks.map((check) => [check.id, { status: "pending", notes: "" } satisfies CheckResult])
  );
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, CheckResult>;
    return { ...defaults, ...stored };
  } catch {
    return defaults;
  }
}

export function saveResults(results: Record<string, CheckResult>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
}

export function downloadReport(results: Record<string, CheckResult>, logs: ProbeLog[]): void {
  const report = {
    buildNumber: BUILD_NUMBER,
    generatedAt: new Date().toISOString(),
    environment: collectEnvironment(),
    results,
    logs
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `mreader-p0-build-${BUILD_NUMBER}-${new Date().toISOString().replaceAll(":", "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function collectEnvironment(): Record<string, unknown> {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    standalone,
    navigatorStandalone: "standalone" in navigator ? Boolean((navigator as Navigator & { standalone?: boolean }).standalone) : false,
    secureContext: window.isSecureContext,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    serviceWorker: "serviceWorker" in navigator,
    opfs: "storage" in navigator && "getDirectory" in navigator.storage,
    pointerEvents: "PointerEvent" in window
  };
}
