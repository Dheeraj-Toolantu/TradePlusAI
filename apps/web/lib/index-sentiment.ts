import { runPythonModule } from "./python";
import { getSentiment } from "./sentiment";
import type { CommoditySentiment } from "./commodity-sentiment";

export type IndexId = "NIFTY" | "BANKNIFTY" | "SENSEX";
export type Lens = "price" | "volume" | "orderflow" | "news" | "social" | "events";
export type TelegramStats = { posts: number; buy_calls: number; sell_calls: number; hype_posts: number; channels: number; views: number };
export type CorporateEvent = { type: string; label: string; title: string; source: string; age_hours: number | null; impact: number; link: string };
export type Deal = { symbol?: string; kind: "BLOCK" | "BULK"; client: string; side: "BUY" | "SELL"; qty: number; price: number; value_cr: number; date: string | null; class: "INSTITUTION" | "PROMOTER" | "STRATEGIC" | "OTHER"; age_hours: number; vs_price_pct: number | null };
export type DealsReading = { score: number; count: number; buy_value_cr: number; sell_value_cr: number; institution_buy_cr: number; institution_sell_cr: number; promoter_sell_cr: number; deals: Deal[] };
export type UpcomingEvent = { date: string; days: number; purpose: string; detail: string; is_results: boolean };
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
  retail: { posts: number; bullish: number; bearish: number; telegram: TelegramStats };
  events: { count: number; deals: DealsReading | null; upcoming: UpcomingEvent[]; events: CorporateEvent[] };
  notes: string[];
  headlines: Array<{ title: string; link: string; source: string; tier: "PREMIUM" | "STANDARD" | "BLOG" | "TELEGRAM"; score: number; age_hours: number; event?: string | null }>;
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
    telegram: { posts: number; buy_calls: number; sell_calls: number; hype_posts: number; most_tipped: Array<{ symbol: string; buy_calls: number; sell_calls: number; hype_posts: number }> };
  };
  corporate: {
    results: Array<{ symbol: string; weight: number; impact: number; title: string; source: string }>;
    results_tone: number | null;
    upcoming: Array<UpcomingEvent & { symbol: string; weight: number }>;
    reporting_weight_7d: number;
    deals: { buy_value_cr: number; sell_value_cr: number; institution_buy_cr: number; promoter_sell_cr: number; count: number; top: Array<Deal & { symbol: string }> };
    notable: Array<CorporateEvent & { symbol: string; weight: number }>;
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
  crowded_stocks: Array<{ symbol: string; name: string; posts: number; retail_mood: number; institutional_footprint: number | null; delivery_pct: number | null; change_pct: number | null; divergence: boolean; read: string; telegram?: TelegramStats }>;
  notes: string[];
  method: string;
};
export type TelegramOptionCall = {
  underlying: string; strike: number; type: "CE" | "PE"; side: "BUY" | "SELL"; contract: string; mentions: number; channels: string[]; channel_count: number;
  consensus_score: number; entry: number | null; target: number | null; stop: number | null; plan_odds: number | null; reward_risk: number | null;
  spot: number | null; moneyness_pct: number | null; otm: boolean | null; far_otm: boolean; latest_age_hours: number; views: number;
  posts: Array<{ channel: string; text: string; link: string; age_hours: number }>;
};
export type TelegramOptions = {
  window_hours: number; posts_scanned: number; calls_parsed: number; consensus: TelegramOptionCall[]; top_pick: TelegramOptionCall | null;
  by_underlying: Array<{ underlying: string; ce_buys: number; pe_buys: number; ce_sells: number; pe_sells: number; bullish_pct: number | null; bias: string }>;
  channels: Array<{ channel: string; posts: number; option_calls: number }>; notes: string[]; method: string;
};
export type IndexSentiment = {
  generated_at: string;
  indices: IndexSentimentReading[];
  retail_desk?: RetailDesk;
  telegram_options?: TelegramOptions;
  /** Crude oil, natural gas, gold, silver, copper; null when that scan failed. */
  commodities?: CommoditySentiment | null;
  market_context: Record<string, number | string | null> | null;
  feeds: Array<{ id: string; name: string; ok: boolean; items: number; fresh: number; cached?: boolean }>;
  freshness: { max_age_hours: number; fresh_window_hours: number };
  sources: Array<{ id: string; name: string; ok: number; failed: number; cached: number; errors: string[] }>;
  method: string;
};

// ~150 feeds, 60+ charts and order books per scan. Re-scan every 5 minutes (stale-while-revalidate):
// one scan per server, shared by every tab and the history recorder, however many pages are open.
const TTL_MS = 5 * 60_000;
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
  if (store.__tradepulseIndexSentimentJob) return store.__tradepulseIndexSentimentJob;
  // Commodities run alongside; their failure never fails the index scan.
  const commodities = runPythonModule<CommoditySentiment>("tradepulse_quant.sentiment.commodity_engine", {}, 40_000).catch(() => null);
  store.__tradepulseIndexSentimentJob = marketContext()
    .then((market_context) => runPythonModule<IndexSentiment>("tradepulse_quant.sentiment.index_engine", { market_context }, 90_000))
    .then(async (scan) => ({ ...scan, commodities: await commodities }))
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
