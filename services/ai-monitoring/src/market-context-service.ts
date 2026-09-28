import type { MarketContextSnapshot } from "../../../packages/domain-contracts/src/ai-trading";
import type { Freshness } from "../../../packages/domain-contracts/src/primitives";

type ContextInput = {
  instrumentId: string;
  symbol: string;
  underlying?: string;
  timeframe: string;
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  analysisId?: string;
  analysis?: Record<string, unknown>;
  optionContract?: Record<string, unknown>;
  marketEvidence?: Record<string, unknown>;
  freshness?: Freshness;
  quality?: MarketContextSnapshot["quality"];
};

export function buildMarketContextSnapshot(input: ContextInput): MarketContextSnapshot {
  const now = new Date().toISOString();
  const candles = input.candles.slice(-500);
  const quality = input.quality ?? "VALID";
  const freshness = input.freshness ?? "FRESH";
  return {
    id: crypto.randomUUID(),
    instrumentId: input.instrumentId,
    symbol: input.symbol,
    underlying: input.underlying ?? input.symbol,
    optionContract: input.optionContract,
    timeframe: input.timeframe,
    candleRange: { first: candles[0]?.timestamp, last: candles.at(-1)?.timestamp, count: candles.length },
    analysisId: input.analysisId,
    marketEvidence: { ...input.marketEvidence, deterministicAnalysis: input.analysis ?? null },
    freshness,
    quality,
    capturedAt: now,
  };
}

export function contextCanBeEvaluated(snapshot: MarketContextSnapshot): boolean {
  return snapshot.freshness === "FRESH" && snapshot.quality === "VALID" && snapshot.candleRange.count > 0;
}
