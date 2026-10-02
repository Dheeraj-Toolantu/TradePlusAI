import { describe, expect, it } from "vitest";
import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { optimizeSettings, precomputeSignals } from "../../services/backtest/src/optimizer";
import { DEFAULT_BACKTEST_SETTINGS, istDay, listSignalSource, runBacktest, type Signal } from "../../services/backtest/src/strategy-backtest";
import { syntheticSessions } from "../../services/backtest/src/synthetic-market";
import { trendPullbackSignalSource } from "../../services/backtest/src/trend-pullback-strategy";

const points = { pnlMode: "POINTS" as const, chargesPerTrade: 0, slippagePoints: 0, lotSize: 1 };

describe("trend-day VWAP pullback strategy", () => {
  const { minute, daily } = syntheticSessions("2026-02-02", "2026-09-30", { seed: 3, regimes: true });
  const from = "2026-04-01";
  const to = "2026-09-30";
  // Synthetic regime days: a day that closed near its extreme in one direction is a trend day.
  const dayDirection = new Map(daily.map((bar) => [istDay(bar.time), (bar.close - bar.open) / (bar.high - bar.low)]));

  it("trades the trend days in the trend's direction and sits out the chop", () => {
    const source = trendPullbackSignalSource("NIFTY", minute, daily);
    const result = runBacktest({ strategy: "TREND_PULLBACK", symbol: "NIFTY", from, to, minute, signalAt: precomputeSignals(minute, source, from, to), settings: { ...points, trailR: 1, timeStopMinutes: 30 } });
    expect(result.trades.length).toBeGreaterThanOrEqual(5);
    const withTrend = result.trades.filter((trade) => { const move = dayDirection.get(trade.day) ?? 0; return Math.abs(move) > 0.6 && Math.sign(move) === (trade.side === "LONG" ? 1 : -1); });
    expect(withTrend.length / result.trades.length).toBeGreaterThanOrEqual(0.75);
    expect(result.metrics.expectancyR).toBeGreaterThan(0);
    expect(source.funnel.trendBars).toBeLessThan(source.funnel.evaluated * 0.3); // most bars are not trend-day bars
    for (const trade of result.trades) expect(trade.reason).toMatch(/trend day .* pullback to EMA20\/VWAP/);
  });

  it("is causal: signals on truncated data match the full-data signals", () => {
    const source = trendPullbackSignalSource("NIFTY", minute, daily);
    const found: Array<{ index: number; signal: Signal }> = [];
    for (let index = 0; index < minute.length && found.length < 5; index += 1) { const signal = source(index); if (signal) found.push({ index, signal }); }
    expect(found.length).toBeGreaterThan(0);
    for (const { index, signal } of found) {
      const cut = trendPullbackSignalSource("NIFTY", minute.slice(0, index + 1), daily);
      let last: Signal | null = null;
      for (let k = 0; k <= index; k += 1) last = cut(k);
      expect(last).toEqual(signal);
    }
  });
});

describe("trailing runner", () => {
  const start = Date.parse("2026-09-30T09:15:00+05:30") / 1000;
  const bars: Bar[] = Array.from({ length: 375 }, (_, m) => ({ time: start + m * 60, open: 25_000, high: 25_001, low: 24_999, close: 25_000 }));
  // Fill at 25,000 (risk 10). Rally to 25,050 by minute 40, then fall back to 25,030.
  for (let m = 22; m <= 40; m += 1) { const p = 25_000 + (m - 21) * 50 / 19; bars[m] = { time: bars[m].time, open: p - 1, high: p + 0.5, low: p - 1.5, close: p }; }
  for (let m = 41; m < 375; m += 1) bars[m] = { time: bars[m].time, open: 25_030, high: 25_031, low: 25_029, close: 25_030 };
  const signal: Signal = { time: start + 21 * 60, side: 1, stop: 24_990, target1: 25_015, target2: 25_020, strategy: "t", reason: "t", confidence: 80 };

  it("books half at T1 and trails the rest 1R behind the best price instead of exiting at T2", () => {
    const result = runBacktest({ strategy: "TREND_PULLBACK", symbol: "NIFTY", from: "2026-09-30", to: "2026-09-30", minute: bars, signalAt: listSignalSource([signal]), settings: { ...points, trailR: 1, timeStopMinutes: 0 } });
    const trade = result.trades[0];
    expect(trade.legs.map((leg) => leg.reason)).toEqual(["TARGET_1", "TRAIL_STOP"]);
    // Best high 25,050.5 → trail at 25,040.5; the drop to 25,029 fills at the open (25,030) through the trail.
    expect(trade.legs[1].price).toBe(25_030);
    expect(trade.points).toBeGreaterThan(20);
  });

  it("with a fixed T2 the same move exits at T2", () => {
    const result = runBacktest({ strategy: "TREND_PULLBACK", symbol: "NIFTY", from: "2026-09-30", to: "2026-09-30", minute: bars, signalAt: listSignalSource([signal]), settings: { ...points, trailR: 0, timeStopMinutes: 0 } });
    expect(result.trades[0].legs.map((leg) => leg.reason)).toEqual(["TARGET_1", "TARGET_2"]);
  });
});

describe("walk-forward optimizer", () => {
  it("chooses on the first two thirds and reports the unseen last third separately", { timeout: 60_000 }, () => {
    const { minute, daily } = syntheticSessions("2026-02-02", "2026-09-30", { seed: 29, regimes: true });
    const signalAt = precomputeSignals(minute, trendPullbackSignalSource("NIFTY", minute, daily), "2026-04-01", "2026-09-30");
    const started = Date.now();
    const result = optimizeSettings({ strategy: "TREND_PULLBACK", symbol: "NIFTY", from: "2026-04-01", to: "2026-09-30", minute, signalAt, settings: { ...DEFAULT_BACKTEST_SETTINGS, trailR: 1 }, usesConfidence: true })!;
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.inSample.to < result.outOfSample.from).toBe(true);
    expect(result.inSample.sessions).toBe(Math.floor((result.inSample.sessions + result.outOfSample.sessions) * 2 / 3));
    expect(result.tested).toBe(648);
    // Ranked by in-sample P&L only.
    const isPnl = result.top.map((row) => row.inSample.netPnl);
    expect([...isPnl].sort((a, b) => b - a)).toEqual(isPnl);
    for (const row of result.top) expect(row.robust).toBe(row.inSample.netPnl > 0 && row.outOfSample.netPnl > 0 && (row.outOfSample.profitFactor ?? Infinity) >= 1.1 && row.outOfSample.trades >= 3);
    expect(result.note.length).toBeGreaterThan(20);
  });
});
