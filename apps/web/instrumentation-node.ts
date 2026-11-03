// Node-only boot work (see instrumentation.ts). Kept in its own module so the edge build never
// bundles it: it reaches Python (node:child_process) through the sentiment recorder.
import { ensureScalperMonitor } from "./lib/scalper-monitor";
import { ensureSentimentRecorder } from "./lib/sentiment-recorder";
import { ensureVwapAutoTrader } from "./lib/vwap-auto-trader";

export function startServerJobs() {
  ensureScalperMonitor();
  ensureSentimentRecorder();
  // Server-side auto-execution of the VWAP-EMA scalper (resumes the saved on/off switch).
  ensureVwapAutoTrader();
}
