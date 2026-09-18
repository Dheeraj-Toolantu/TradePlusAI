import type { IsoTimestamp } from "./primitives";

export type AnalysisQuality = "VALID" | "INSUFFICIENT_DATA" | "INVALID" | "STALE" | "DISCONTINUOUS";
export type NoTradeStatus = "NO_TRADE" | "WAIT_FOR_CONFIRMATION" | "WAIT_FOR_BREAKOUT" | "INVALIDATED";
export type SetupStatus = NoTradeStatus | "CONFIRMED" | "WATCHING" | "ACTIVE" | "COMPLETED";
export type Direction = "LONG" | "SHORT";

export type OhlcvCandle = {
  timestamp: IsoTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type AnalysisRequest = {
  instrumentId: string;
  symbol: string;
  timeframe: string;
  candles: OhlcvCandle[];
  strategyVersion: string;
  configuration?: Record<string, unknown>;
  higherTimeframe?: { timeframe: string; candles: OhlcvCandle[] };
  entryTimeframe?: { timeframe: string; candles: OhlcvCandle[] };
  option?: { instrumentId: string; candles: OhlcvCandle[] } | null;
};

export type AnalysisBlocker = { code: string; reason: string; observed?: unknown; threshold?: unknown };
export type AnalysisResponse = {
  analysisId: string;
  status: SetupStatus;
  quality: AnalysisQuality;
  dataQuality: { status: AnalysisQuality; reasons: string[] };
  indicators: Record<string, number | null> | null;
  marketStructure: Record<string, unknown> | null;
  patterns: Array<Record<string, unknown>>;
  zones: Array<Record<string, unknown>>;
  confirmation: { total: number; quality: string; components: Record<string, number>; blockers: AnalysisBlocker[] } | null;
  tradeSetup: TradeSetup | null;
  annotations: ChartAnnotation[];
  explanation: { status: "AVAILABLE" | "UNAVAILABLE"; whyThisSetup: string[]; risks: string[] };
  versions: { strategy: string; calculation: string; contract: string };
};

export type TradeSetup = {
  symbol: string;
  direction: Direction;
  timeframe: string;
  entry: { min: number; max: number; method: string };
  stopLoss: { price: number; reference: string; volatilityBuffer: number };
  targets: Array<{ label: string; price: number; technicalReference: string; available: boolean }>;
  riskReward: Array<{ targetLabel: string; risk: number; reward: number; ratio: number }>;
  confidence: number;
  pattern: string | null;
  trend: string;
  reasons: string[];
  risks: string[];
  invalidation: string;
};

export type ChartAnnotation = {
  id: string;
  setupId: string;
  annotationType: string;
  timeframe: string;
  priceMin?: number;
  priceMax?: number;
  label: string;
  lifecycleState: SetupStatus;
};
