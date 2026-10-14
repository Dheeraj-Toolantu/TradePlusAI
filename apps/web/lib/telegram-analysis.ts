import { runPythonModule } from "./python";
import type { TelegramAnalysis } from "./telegram-channels";
import { spots } from "./telegram-live";

export { MAX_ANALYSIS_CHANNELS, normalizeChannel, type TelegramAnalysis } from "./telegram-channels";

// Same channels and window within a minute reuse the last analysis.
const TTL_MS = 60_000;
const store = globalThis as typeof globalThis & { __tradepulseTelegramAnalysis?: Map<string, { at: number; value: Promise<TelegramAnalysis> }> };

export function analyseTelegramChannels(channels: string[], windowHours = 12): Promise<TelegramAnalysis> {
  const cache = (store.__tradepulseTelegramAnalysis ??= new Map());
  const key = `${windowHours}|${[...channels].map((name) => name.toLowerCase()).sort().join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  for (const [stale, entry] of cache) if (Date.now() - entry.at >= TTL_MS) cache.delete(stale);
  const value = runPythonModule<TelegramAnalysis & { error?: string }>("tradepulse_quant.sentiment.telegram_analysis", { channels, window_hours: windowHours, spots: spots() }, 45_000)
    .then((result) => { if (result.error) throw new Error(result.error); return result; });
  value.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), value });
  return value;
}
