import { runPythonModule } from "./python";
import { getSentiment } from "./sentiment";

export type IndexId = "NIFTY" | "BANKNIFTY" | "SENSEX";
export type Lens = "price" | "volume" | "orderflow" | "news" | "social";
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
  orderflow: { buy_pct: number | null; buy_qty: number | null; sell_qty: number | null; bid_orders: number | null; ask_orders: number | null; delivery_pct: number | null };
  news_count: number;
  news_fresh_count: number;
  premium_news_count: number;
  latest_news_age_hours: number | null;
  social_count: number;
  retail: { posts: number; bullish: number; bearish: number };
  notes: string[];
  headlines: Array<{ title: string; link: string; source: string; tier: "PREMIUM" | "STANDARD" | "BLOG"; score: number; age_hours: number }>;
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
  orderflow: { buy_pct: number | null; sell_pct?: number; delivery_pct: number | null; buyer_dominated: number; seller_dominated: number; buy_qty: number; sell_qty: number; stocks_covered: number };
  retail: {
    posts: number; bullish: number; bearish: number; bullish_pct: number | null; mood: number | null;
    mmi_score: number | null; mmi_value: string | null; retail_market_score: number | null;
    most_discussed: Array<{ symbol: string; posts: number; mood: number | null }>;
  };
  freshness: { max_age_hours: number; fresh_window_hours: number; news_items: number; fresh_items: number; premium_items: number; latest_news_age_hours: number | null; stocks_with_news: number };
  coverage: { stocks_scored: number; stocks_total: number; weight_scored_pct: number };
  constituents: ConstituentSentiment[];
};
export type Participant = {
  futures_long: number; futures_short: number; futures_long_pct: number | null; futures_score: number | null; options_net: number | null;
  call_long: number; put_long: number; call_short: number; put_short: number;
  futures_long_change?: number; futures_short_change?: number; previous_date?: string; call_put_long_ratio?: number;
};
export type Contrarian = { bias: "BEARISH" | "LEAN_BEARISH" | "NONE" | "LEAN_BULLISH" | "BULLISH" | "NO_DATA"; strength: number; action: string };
export type RetailDesk = {
  generated_at: string;
  participants: Partial<Record<"CLIENT" | "PRO" | "FII" | "DII", Participant>> | null;
  participants_date: string | null;
  participants_error: string | null;
  mmi_score: number | null;
  mmi_value: string | null;
  indices: Array<{ id: IndexId; name: string; crowd_score: number | null; crowd: string; inputs: number; forum_mood: number | null; posts: number; bullish_pct: number | null; index_sentiment: number | null; contrarian: Contrarian }>;
  crowded_stocks: Array<{ symbol: string; name: string; posts: number; retail_mood: number; institutional_footprint: number | null; delivery_pct: number | null; change_pct: number | null; divergence: boolean; read: string }>;
  notes: string[];
  method: string;
};
export type IndexSentiment = {
  generated_at: string;
  indices: IndexSentimentReading[];
  retail_desk?: RetailDesk;
  market_context: Record<string, number | string | null> | null;
  feeds: Array<{ id: string; name: string; ok: boolean; items: number; fresh: number }>;
  freshness: { max_age_hours: number; fresh_window_hours: number };
  sources: Array<{ id: string; name: string; ok: number; failed: number; cached: number; errors: string[] }>;
  method: string;
};

// ~150 feeds, 60+ charts and order books per scan. News older than 8 h is ignored, so re-scan
// every 10 minutes (stale-while-revalidate) to keep the window filled with the latest items.
const TTL_MS = 10 * 60_000;
export const INDEX_REFRESH_MIN_MS = 2 * 60_000;
const store = globalThis as typeof globalThis & { __tradepulseIndexSentiment?: { at: number; value: IndexSentiment } | null; __tradepulseIndexSentimentJob?: Promise<IndexSentiment> | null };

async function marketContext() {
  // Never wait on the market sentiment scan: use whatever it has cached.
  const sentiment = await getSentiment({ wait: false }).catch(() => null);
  const composite = sentiment?.composite;
  if (!composite) return null;
  const mmi = sentiment?.factors?.find((factor) => factor.id === "tickertape_mmi" && factor.ok);
  return {
    overall_score: composite.overall.score, india_score: composite.india.score, global_score: composite.global.score, retail_score: composite.retail.score,
    mmi_score: mmi?.score ?? null, mmi_value: mmi?.value ?? null,
  };
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
