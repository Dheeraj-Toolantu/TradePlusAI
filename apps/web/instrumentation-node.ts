// Node-only boot work (see instrumentation.ts). Kept in its own module so the edge build never
// bundles it: it reaches Python (node:child_process) through the sentiment recorder.
import { ensureScalperMonitor } from "./lib/scalper-monitor";
import { ensureSentimentRecorder } from "./lib/sentiment-recorder";

export function startServerJobs() {
  ensureScalperMonitor();
  ensureSentimentRecorder();
}
