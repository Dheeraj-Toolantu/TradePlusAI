/**
 * Next.js server boot hook. Starts the paper Smart Scalper's server-side exit monitor, which also
 * reloads persisted open scalper positions, so stops, targets, the staged trail, time stops and the
 * 15:15 square-off keep running without a browser (and after a restart).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureScalperMonitor } = await import("./lib/scalper-monitor");
  ensureScalperMonitor();
}
