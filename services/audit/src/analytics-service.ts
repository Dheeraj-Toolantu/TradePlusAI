export function aggregatePerformance(returns: number[], mode: "PAPER" | "ASSISTED" | "ALGO_LIVE", options: { rMultiples?: number[]; costs?: number; slippage?: number; exposure?: number; regimes?: string[] } = {}) {
  const wins = returns.filter((value) => value > 0).length;
  const total = returns.reduce((sum, value) => sum + value, 0);
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const value of returns) { equity += value; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const rMultiples = options.rMultiples ?? returns;
  const positive = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const sortedR = [...rMultiples].sort((left, right) => left - right);
  const medianR = sortedR.length ? sortedR.length % 2 ? sortedR[Math.floor(sortedR.length / 2)] : (sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2 : 0;
  const regimeBreakdown: Record<string, { trades: number; winRate: number; expectancy: number }> = {};
  for (const [index, regime] of (options.regimes ?? []).entries()) { const value = returns[index]; if (value === undefined) continue; const current = regimeBreakdown[regime] ?? { trades: 0, winRate: 0, expectancy: 0 }; current.trades += 1; current.winRate += value > 0 ? 1 : 0; current.expectancy += value; regimeBreakdown[regime] = current; }
  for (const value of Object.values(regimeBreakdown)) { value.winRate /= value.trades; value.expectancy /= value.trades; }
  return { mode, trades: returns.length, winRate: returns.length ? wins / returns.length : 0, expectancy: returns.length ? total / returns.length : 0, maxDrawdown, profitFactor: negative ? positive / negative : positive ? Number.POSITIVE_INFINITY : 0, averageR: rMultiples.length ? rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length : 0, medianR, costs: options.costs ?? 0, slippage: options.slippage ?? 0, exposure: options.exposure ?? 0, regimeBreakdown };
}