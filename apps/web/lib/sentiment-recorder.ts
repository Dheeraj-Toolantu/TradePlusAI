import { getIndexSentiment } from "./index-sentiment";
import { noteRecorder, recordSentiment, type RecordResult } from "./sentiment-history";

/**
 * Records sentiment history from inside the web app's own server process.
 *
 * History used to be saved only when the separate API server (apps/api) POSTed to
 * `${WEB_APP_URL}/api/sentiment-history` every minute. If that server wasn't running, or the web
 * app wasn't on the URL it expected (http://localhost:3000 by default), nothing was ever saved and
 * the Sentiment history panel stayed empty. The web app now records on its own, every minute from
 * boot (instrumentation.ts). The API server's POST still works and is harmless: both go through
 * the same in-process recorder, which saves one snapshot per 15-minute slot plus one per reversal.
 * SENTIMENT_RECORDER=off turns both off (e.g. when an external scheduler calls the POST).
 */
export const SENTIMENT_RECORD_MS = Math.max(30_000, Number(process.env.SENTIMENT_RECORD_MS) || 60_000);
const holder = globalThis as typeof globalThis & { __tradepulseSentimentRecorderTimer?: ReturnType<typeof setInterval> | null };

/** One scan + record; a failed scan is counted in the recorder status too. */
export async function recordLatestSentiment(): Promise<RecordResult> {
  let scan;
  try {
    scan = await getIndexSentiment();
  } catch (error) {
    noteRecorder(error);
    throw error;
  }
  return recordSentiment(scan);
}

export function ensureSentimentRecorder(): boolean {
  if (process.env.SENTIMENT_RECORDER === "off" || holder.__tradepulseSentimentRecorderTimer) return false;
  const tick = () => {
    recordLatestSentiment()
      .then((result) => { if (result.recorded) console.log(`Sentiment history: saved ${result.snapshotId} (${result.reasons.join(", ")})`); })
      .catch((error: unknown) => console.warn(`Sentiment history: ${error instanceof Error ? error.message : "recording failed"}`));
  };
  holder.__tradepulseSentimentRecorderTimer = setInterval(tick, SENTIMENT_RECORD_MS);
  holder.__tradepulseSentimentRecorderTimer.unref?.();
  setTimeout(tick, 10_000).unref?.(); // let the server finish starting first
  return true;
}
