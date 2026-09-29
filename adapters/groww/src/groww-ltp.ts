import type { GrowwTransport } from "./groww-adapter";
import { isRateLimitError } from "./groww-rate-limiter";

export type GrowwSegment = "CASH" | "FNO";

const BATCH_SIZE = 50; // Groww's per-request instrument cap for LTP
const BATCH_RETRY_MS = 5 * 60_000;
const TICK_CACHE_MS = 1_000;

/** Exchange-qualified symbol (e.g. NSE_NIFTY, BSE_SENSEX, NSE_NIFTY25O0725000CE). */
export function exchangeSymbol(symbol: string, segment: GrowwSegment): string {
  const upper = symbol.trim().toUpperCase();
  if (segment === "CASH") {
    if (upper === "INDIA VIX" || upper === "INDIAVIX") return "NSE_INDIAVIX";
    if (upper === "SENSEX" || upper === "BANKEX") return `BSE_${upper}`;
    return `NSE_${upper}`;
  }
  return `${/^(SENSEX|BANKEX)/.test(upper) ? "BSE" : "NSE"}_${upper}`;
}

const priceOf = (value: unknown): number | null => {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>).ltp ?? (value as Record<string, unknown>).last_price : value;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
};

/**
 * Last traded prices for many instruments in as few calls as possible: one LTP request per 50
 * symbols instead of one quote request per symbol. If the batch endpoint is rejected for any
 * reason other than throttling, falls back to per-symbol quotes and retries the batch later.
 */
export function createLtpFetcher(transport: GrowwTransport) {
  let batchBlockedUntil = 0;

  async function single(symbol: string, segment: GrowwSegment): Promise<number | null> {
    const [exchange, ...rest] = exchangeSymbol(symbol, segment).split("_");
    const body = await transport.request(`/v1/live-data/quote?exchange=${exchange}&segment=${segment}&trading_symbol=${encodeURIComponent(rest.join("_"))}`, { method: "GET", cacheTtlMs: TICK_CACHE_MS });
    return priceOf((body as { payload?: unknown })?.payload);
  }

  async function batch(symbols: string[], segment: GrowwSegment): Promise<Map<string, number>> {
    const keys = symbols.map((symbol) => exchangeSymbol(symbol, segment));
    const body = await transport.request(`/v1/live-data/ltp?segment=${segment}&exchange_symbols=${keys.map(encodeURIComponent).join(",")}`, { method: "GET", cacheTtlMs: TICK_CACHE_MS });
    const payload = ((body as { payload?: Record<string, unknown> })?.payload ?? {}) as Record<string, unknown>;
    const prices = new Map<string, number>();
    symbols.forEach((symbol, index) => {
      const price = priceOf(payload[keys[index]]);
      if (price !== null) prices.set(symbol, price);
    });
    return prices;
  }

  return async function fetchLtp(symbols: string[], segment: GrowwSegment): Promise<Map<string, number>> {
    const unique = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    const prices = new Map<string, number>();
    for (let index = 0; index < unique.length; index += BATCH_SIZE) {
      const chunk = unique.slice(index, index + BATCH_SIZE);
      if (batchBlockedUntil <= Date.now()) {
        try {
          const batched = await batch(chunk, segment);
          // An empty answer for a non-empty request means the batch format was not understood.
          if (batched.size === 0) throw new Error("LTP batch returned no prices");
          for (const [symbol, price] of batched) prices.set(symbol, price);
          continue;
        } catch (error) {
          if (isRateLimitError(error)) throw error;
          batchBlockedUntil = Date.now() + BATCH_RETRY_MS;
        }
      }
      const results = await Promise.allSettled(chunk.map(async (symbol) => [symbol, await single(symbol, segment)] as const));
      const limited = results.find((result) => result.status === "rejected" && isRateLimitError(result.reason));
      if (limited && limited.status === "rejected") throw limited.reason;
      for (const result of results) if (result.status === "fulfilled" && result.value[1] !== null) prices.set(result.value[0], result.value[1]);
    }
    return prices;
  };
}
