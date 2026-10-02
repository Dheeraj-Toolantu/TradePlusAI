import { runPythonModule } from "./python";

export type SentimentAggregate = { score: number; label: string; items: number; bullish_pct: number; bearish_pct: number };
export type Sentiment = {
  generated_at: string;
  summary: Record<"india" | "india_retail" | "india_news" | "global" | "global_retail" | "global_news", SentimentAggregate>;
  contrarian_note: string | null;
  divergence: string | null;
  event_risk: Array<{ event: string; mentions: number; latest: string; link: string; age_hours: number }>;
  top_bullish: Headline[];
  top_bearish: Headline[];
  global_headlines: Headline[];
  sources: Array<{ id: string; name: string; region: string; audience: string; ok: boolean; items: number; error: string | null }>;
  sources_ok: number;
  sources_total: number;
  method: string;
};
type Headline = { title: string; link: string; source: string; audience: string; published: string; age_hours: number; score: number; topic: string };

// Public feeds move slowly and must not be hammered: one scan per 10 minutes per server,
// stale-while-revalidate so page loads never wait on 15 feeds.
const TTL_MS = 10 * 60_000;
// A manual refresh skips the TTL, but never re-scans the feeds more than once a minute.
export const MANUAL_REFRESH_MIN_MS = 60_000;
const store = globalThis as typeof globalThis & { __tradepulseSentiment?: { at: number; value: Sentiment } | null; __tradepulseSentimentJob?: Promise<Sentiment> | null };

function refresh(): Promise<Sentiment> {
  store.__tradepulseSentimentJob ??= runPythonModule<Sentiment>("tradepulse_quant.sentiment.engine", {}, 45_000)
    .then((value) => { store.__tradepulseSentiment = { at: Date.now(), value }; return value; })
    .finally(() => { store.__tradepulseSentimentJob = null; });
  return store.__tradepulseSentimentJob;
}

export async function getSentiment(options: { wait?: boolean; force?: boolean } = {}): Promise<Sentiment | null> {
  const cached = store.__tradepulseSentiment;
  if (options.force && !(cached && Date.now() - cached.at < MANUAL_REFRESH_MIN_MS)) return refresh();
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const job = refresh();
  if (cached && !options.wait) { job.catch(() => undefined); return cached.value; }
  if (!options.wait) { job.catch(() => undefined); return null; }
  return job;
}

/** Compact form consumed by the market-intel engine. */
export function sentimentForIntel(value: Sentiment | null) {
  if (!value) return null;
  return {
    india_score: value.summary.india.score,
    india_label: value.summary.india.label,
    retail_score: value.summary.india_retail.label === "INSUFFICIENT_DATA" ? null : value.summary.india_retail.score,
    news_score: value.summary.india_news.score,
    global_score: value.summary.global.score,
    global_label: value.summary.global.label,
    event_risk: value.event_risk.map((event) => event.event),
    contrarian_note: value.contrarian_note,
  };
}
