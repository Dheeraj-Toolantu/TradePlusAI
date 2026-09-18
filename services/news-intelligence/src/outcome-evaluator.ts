export const OUTCOME_HORIZONS = ["1m", "5m", "15m", "30m", "1h", "1d"] as const;

export function evaluateOutcome(before: number, after: number) { return before === 0 ? 0 : ((after - before) / before) * 100; }