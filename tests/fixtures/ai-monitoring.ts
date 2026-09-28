import type { ModelEvaluationResponse } from "../../services/ai-monitoring/src/model-gateway";

export const freshBullishResponse = (): ModelEvaluationResponse => ({ schemaVersion: "ai-trading-evaluation.v1", providerRequestId: "fixture-provider", modelAlias: "fixture-model", direction: "BULLISH", confidence: 82, evidence: [{ source: "trend", observation: "Higher highs and higher lows", supports: "BULLISH" }], explanation: "Trend and volume align.", invalidation: "Close below support.", warnings: [], latencyMs: 1 });
export const freshBearishResponse = (): ModelEvaluationResponse => ({ ...freshBullishResponse(), direction: "BEARISH", confidence: 79, evidence: [{ source: "structure", observation: "Lower highs and lower lows", supports: "BEARISH" }], explanation: "Bearish structure is confirmed." });
export const validContext = () => ({ instrumentId: "nifty", symbol: "NIFTY", timeframe: "5m", candles: [{ timestamp: "2026-09-20T09:20:00.000Z", open: 100, high: 105, low: 99, close: 104, volume: 1000 }], analysisId: "fixture-analysis", analysis: { status: "CONFIRMED", trend: "UPTREND" }, marketEvidence: { volume: "SUPPORTIVE" } });
export const staleContext = () => ({ ...validContext(), freshness: "STALE" as const });
export const unavailableContext = () => ({ ...validContext(), quality: "INSUFFICIENT_DATA" as const });
export const malformedResponse = () => ({ ...freshBullishResponse(), confidence: 101 });
