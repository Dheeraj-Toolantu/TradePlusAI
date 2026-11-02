/**
 * Next.js server boot hook. Starts the paper Smart Scalper's server-side exit monitor, which also
 * reloads persisted open scalper positions, so stops, targets, the staged trail, time stops and the
 * 15:15 square-off keep running without a browser (and after a restart). Also starts the sentiment
 * history recorder, so the Sentiment history panel fills without depending on the API server.
 *
 * The import sits inside the NEXT_RUNTIME check (the pattern Next.js documents) so the edge build
 * drops it; an early return does not, and the edge build then fails on node:child_process.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startServerJobs } = await import("./instrumentation-node");
    startServerJobs();
  }
}
