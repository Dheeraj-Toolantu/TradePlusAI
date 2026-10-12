import { runPythonModule } from "./python";
import { getSentiment } from "./sentiment";

export type IndexId = "NIFTY" | "BANKNIFTY" | "SENSEX";
export type Lens = "price" | "volume" | "news" | "social";
export type ConstituentSentiment = {
  symbol: string;
  name: string;
  sector: string;
  weight: number;
  score: number | null;
  label: string;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  components: Record<Lens, number | null>;
  social_raw: number | null;
  contribution: number | null;
  price: number | null;
  change_pct: number | null;
  five_day_pct: number | null;
  vs_20dma_pct: number | null;
  volume_ratio: number | null;
  news_count: number;
  social_count: number;
  notes: string[];
  headlines: Array<{ title: string; link: string; source: string; score: number; age_hours: number }>;
};
export type Driver = { symbol: string; name: string; score: number; weight: number; contribution: number };
export type IndexSentimentReading = {
  id: IndexId;
  name: string;
  score: number | null;
  label: string;
  zone: string;
  bias: string;
  constituent_score: number | null;
  macro_score: number | null;
  lenses: Record<Lens | "constituents" | "heavyweights" | "rest", number | null>;
  breadth: { bullish_pct: number; bearish_pct: number; neutral_pct: number; advances: number; declines: number; unchanged: number };
  sectors: Array<{ sector: string; weight: number; score: number | null; stocks: number }>;
  drivers: { positive: Driver[]; negative: Driver[] };
  psychology: string[];
  quote: { price: number; change_pct: number | null } | null;
  coverage: { stocks_scored: number; stocks_total: number; weight_scored_pct: number };
  constituents: ConstituentSentiment[];
};
export type IndexSentiment = {
  generated_at: string;
  indices: IndexSentimentReading[];
  market_context: Record<string, number | null> | null;
  sources: Array<{ id: string; name: string; ok: number; failed: number; cached: number; errors: string[] }>;
  method: string;
};

// ~130 feeds and 60+ charts per scan: one scan per 15 minutes per server, stale-while-revalidate.
const TTL_MS = 15 * 60_000;
export const INDEX_REFRESH_MIN_MS = 2 * 60_000;
const store = globalThis as typeof globalThis & { __tradepulseIndexSentiment?: { at: number; value: IndexSentiment } | null; __tradepulseIndexSentimentJob?: Promise<IndexSentiment> | null };

async function marketContext() {
  // Never wait on the market sentiment scan: use whatever it has cached.
  const sentiment = await getSentiment({ wait: false }).catch(() => null);
  const composite = sentiment?.composite;
  if (!composite) return null;
  return { overall_score: composite.overall.score, india_score: composite.india.score, global_score: composite.global.score, retail_score: composite.retail.score };
}

function refresh(): Promise<IndexSentiment> {
  store.__tradepulseIndexSentimentJob ??= marketContext()
    .then((market_context) => runPythonModule<IndexSentiment>("tradepulse_quant.sentiment.index_engine", { market_context }, 90_000))
    .then((value) => { store.__tradepulseIndexSentiment = { at: Date.now(), value }; return value; })
    .finally(() => { store.__tradepulseIndexSentimentJob = null; });
  return store.__tradepulseIndexSentimentJob;
}

export async function getIndexSentiment(options: { force?: boolean } = {}): Promise<IndexSentiment> {
  const cached = store.__tradepulseIndexSentiment;
  if (options.force && !(cached && Date.now() - cached.at < INDEX_REFRESH_MIN_MS)) return refresh();
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (cached) { refresh().catch(() => undefined); return cached.value; }
  return refresh();
}
