import { runPythonModule } from "./python";
import type { IndexSentiment, TelegramOptions, TelegramStats } from "./index-sentiment";

export type TelegramLive = {
  generated_at: string;
  signature: string;
  window_hours: number;
  options: TelegramOptions;
  stocks: Record<string, TelegramStats & { mood: number | null }>;
  feed: Array<{ channel: string; text: string; link: string; published: string; age_hours: number; views: number; stocks: string[]; options: string[] }>;
  channels: Array<{ id: string; name: string; ok: boolean; items: number; fresh: number; error: string | null; cached?: boolean; reused?: boolean }>;
};

// Ten channels x 1-2 preview pages: cheap enough to re-read every ~45 s, never more than every 20 s.
const TTL_MS = 45_000;
export const TELEGRAM_REFRESH_MIN_MS = 20_000;
const store = globalThis as typeof globalThis & {
  __tradepulseTelegramLive?: { at: number; value: TelegramLive } | null;
  __tradepulseTelegramJob?: Promise<TelegramLive> | null;
  __tradepulseIndexSentiment?: { at: number; value: IndexSentiment } | null;
};

/** Last prices from the cached index scan, so option strikes get moneyness without another fetch. */
export function spots(): Record<string, number> {
  const scan = store.__tradepulseIndexSentiment?.value;
  const out: Record<string, number> = {};
  for (const index of scan?.indices ?? []) {
    if (index.quote?.price) out[index.id] = index.quote.price;
    for (const stock of index.constituents) if (stock.price) out[stock.symbol] = stock.price;
  }
  return out;
}

function refresh(): Promise<TelegramLive> {
  store.__tradepulseTelegramJob ??= runPythonModule<TelegramLive>("tradepulse_quant.sentiment.telegram_scan", { spots: spots() }, 40_000)
    .then((value) => { store.__tradepulseTelegramLive = { at: Date.now(), value }; return value; })
    .finally(() => { store.__tradepulseTelegramJob = null; });
  return store.__tradepulseTelegramJob;
}

export async function getTelegramLive(options: { force?: boolean } = {}): Promise<TelegramLive> {
  const cached = store.__tradepulseTelegramLive;
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < (options.force ? TELEGRAM_REFRESH_MIN_MS : TTL_MS)) return cached.value;
  if (cached && !options.force) { refresh().catch(() => undefined); return cached.value; }
  return refresh();
}
