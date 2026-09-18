import type { Freshness } from "../../../packages/domain-contracts/src/primitives";

export type Quote = { symbol: string; price: number; bid?: number; ask?: number; timestamp: string; freshness: Freshness };

export function assessQuoteQuality(quote: Quote, now = Date.now(), maxAgeMs = 5_000, referencePrice?: number, maxDeviation = 0.1): Quote {
  const age = now - new Date(quote.timestamp).getTime();
  const crossed = quote.bid !== undefined && quote.ask !== undefined && quote.bid > quote.ask;
  const invalid = !Number.isFinite(quote.price) || (quote.bid !== undefined && !Number.isFinite(quote.bid)) || (quote.ask !== undefined && !Number.isFinite(quote.ask));
  const outlier = referencePrice !== undefined && referencePrice > 0 && Math.abs(quote.price - referencePrice) / referencePrice > maxDeviation;
  return { ...quote, freshness: crossed || age > maxAgeMs || invalid || outlier ? "STALE" : "FRESH" };
}