import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { istDay, istMinute, runBacktest, type BacktestMetrics, type BacktestSettings, type Signal, type StrategyId } from "./strategy-backtest";

/**
 * Walk-forward settings optimizer.
 *
 * Signals are computed ONCE (strategies decide independently of the simulator's position state), then
 * the simulator is replayed for every combination of execution/risk settings. Settings are chosen on
 * the first two thirds of the sessions (in-sample) and then scored on the last third (out-of-sample),
 * which the optimizer never saw. Only out-of-sample results say anything about the future; a setting
 * that is only good in-sample is curve-fitted.
 */

export type SignalAt = (index: number, minute: Bar[]) => Signal | null;

/** Evaluates a signal source once for every bar that could ever be asked, and serves it from memory. */
export function precomputeSignals(minute: Bar[], signalAt: SignalAt, from: string, to: string): SignalAt {
  const cache = new Map<number, Signal>();
  for (let index = 0; index < minute.length - 1; index += 1) {
    const day = istDay(minute[index].time);
    if (day < from || day > to) continue;
    const close = istMinute(minute[index].time + 60);
    if (close < 9 * 60 + 15 || close > 15 * 60 + 30) continue;
    const signal = signalAt(index, minute);
    if (signal) cache.set(index, signal);
  }
  return (index) => cache.get(index) ?? null;
}

export type OptimizerRow = {
  settings: Partial<BacktestSettings>;
  inSample: Pick<BacktestMetrics, "trades" | "winRate" | "netPnl" | "profitFactor" | "expectancyR" | "maxDrawdown">;
  outOfSample: Pick<BacktestMetrics, "trades" | "winRate" | "netPnl" | "profitFactor" | "expectancyR" | "maxDrawdown">;
  robust: boolean;
};

export type OptimizerResult = {
  inSample: { from: string; to: string; sessions: number };
  outOfSample: { from: string; to: string; sessions: number };
  tested: number;
  baseline: OptimizerRow;
  top: OptimizerRow[];
  note: string;
};

const pick = (m: BacktestMetrics) => ({ trades: m.trades, winRate: m.winRate, netPnl: m.netPnl, profitFactor: m.profitFactor, expectancyR: m.expectancyR, maxDrawdown: m.maxDrawdown });

export function optimizeSettings(input: { strategy: StrategyId; symbol: string; from: string; to: string; minute: Bar[]; signalAt: SignalAt; settings: BacktestSettings; usesConfidence: boolean }): OptimizerResult | null {
  const sessions = [...new Set(input.minute.map((bar) => istDay(bar.time)).filter((day) => day >= input.from && day <= input.to))].sort();
  if (sessions.length < 9) return null;
  const split = Math.floor(sessions.length * 2 / 3);
  const inSample = { from: sessions[0], to: sessions[split - 1], sessions: split };
  const outOfSample = { from: sessions[split], to: sessions.at(-1)!, sessions: sessions.length - split };

  const grid: Array<Partial<BacktestSettings>> = [];
  const windows: Array<[string, string]> = [["09:35", "14:45"], ["09:45", "13:30"], ["10:00", "14:30"]];
  const confidences = input.usesConfidence ? [input.settings.minConfidence, 65, 75] : [input.settings.minConfidence];
  for (const timeStopMinutes of [0, 15, 30, 45])
    for (const partialAtT1 of [true, false])
      for (const trailR of [0, 1, 1.5])
        for (const minConfidence of [...new Set(confidences)])
          for (const maxTradesPerDay of [1, 2, 3])
            for (const [entryStart, entryEnd] of windows)
              grid.push({ timeStopMinutes, partialAtT1, trailR, minConfidence, maxTradesPerDay, entryStart, entryEnd });

  const run = (overrides: Partial<BacktestSettings>, range: { from: string; to: string }) =>
    runBacktest({ strategy: input.strategy, symbol: input.symbol, from: range.from, to: range.to, minute: input.minute, signalAt: input.signalAt, settings: { ...input.settings, ...overrides } }).metrics;
  // Enough trades to mean something without excluding selective strategies (a trend-day system may
  // only trade once or twice a week).
  const minTrades = Math.max(6, Math.round(split / 12));
  const row = (overrides: Partial<BacktestSettings>): OptimizerRow => {
    const is = run(overrides, inSample);
    const oos = run(overrides, outOfSample);
    return { settings: overrides, inSample: pick(is), outOfSample: pick(oos), robust: is.netPnl > 0 && oos.netPnl > 0 && (oos.profitFactor ?? Infinity) >= 1.1 && oos.trades >= 3 };
  };

  // Rank on in-sample only; out-of-sample is reported, never used for selection.
  const scored = grid.map((overrides) => ({ overrides, is: run(overrides, inSample) }))
    .filter((item) => item.is.trades >= minTrades)
    .sort((a, b) => b.is.netPnl - a.is.netPnl || (b.is.profitFactor ?? 99) - (a.is.profitFactor ?? 99));
  const top = scored.slice(0, 5).map((item) => row(item.overrides));
  const baseline = row({});
  const robustCount = top.filter((item) => item.robust).length;
  const note = !top.length
    ? `No setting produced ${minTrades}+ in-sample trades; the period is too short or the strategy too selective to optimize.`
    : robustCount
      ? `${robustCount} of the top ${top.length} in-sample settings also made money out-of-sample. Prefer those; re-check on a different period before trusting them.`
      : "None of the best in-sample settings held up out-of-sample: the in-sample edge is likely curve-fitting. Do not trade these settings.";
  return { inSample, outOfSample, tested: grid.length, baseline, top, note };
}
