export type Regime = "BULL_TREND" | "BEAR_TREND" | "RANGE" | "HIGH_VOLATILITY" | "EVENT_RISK";

export function classifyRegime(scores: { trend: number; volatility: number; eventRisk: number }): Regime {
  if (scores.eventRisk >= 80) return "EVENT_RISK";
  if (scores.volatility >= 80) return "HIGH_VOLATILITY";
  if (scores.trend >= 60) return "BULL_TREND";
  if (scores.trend <= 40) return "BEAR_TREND";
  return "RANGE";
}