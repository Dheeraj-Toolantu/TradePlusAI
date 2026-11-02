import { describe, expect, it } from "vitest";
import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { listSignalSource, runBacktest, type Signal } from "../../services/backtest/src/strategy-backtest";
import { adxSeries, vwapEmaAdxSignalSource } from "../../services/backtest/src/vwap-ema-adx-strategy";

// The live strategy's test tape (quant/tests/test_scalp_strategy.py: tape()): opening chop, a measured
// trend, a pullback into the 9 EMA and a resumption candle on 1.8x volume, 28 one-minute bars.
const CHOP = [3, -3, 4, -5, 3, -4, 5, -3, 2, -4, 3, -2, 4, -3];
const TREND = [4, 2, 5, -2, 3, 4, -1, 2, 3, 1];
const PULLBACK = [-4, -3, -2];
const RESUME = [7];
const T0 = Date.parse("2026-11-02T09:15:00+05:30") / 1000;

function tape(direction: 1 | -1, base = 24_860): Bar[] {
  const path = [...CHOP, ...TREND, ...PULLBACK, ...RESUME];
  let price = base;
  return path.map((step, i) => {
    const open = price;
    const close = price + step * direction;
    price = close;
    return { time: T0 + i * 60, open, high: Math.max(open, close) + 3, low: Math.min(open, close) - 3, close, volume: i === path.length - 1 ? 9000 : 5000 + (i % 4) * 300 };
  });
}

describe("VWAP-EMA-ADX backtest signals match the live strategy's tape rules", () => {
  // Reference values from the live Python strategy on the same tape (scalp_strategy.read_tape).
  it.each([[1, 24_867.6113], [-1, 24_852.3887]] as const)("side %i: trigger, ADX and structural stop", (direction, stop) => {
    const bars = tape(direction);
    const source = vwapEmaAdxSignalSource("NIFTY", bars);
    const fired = bars.map((_, index) => source(index)).map((item, index) => [index, item] as const).filter(([, item]) => item);
    expect(fired).toHaveLength(1);
    const [index, signal] = fired[0];
    expect(index).toBe(27); // the 09:42 resumption candle, as live
    expect(signal!.side).toBe(direction);
    expect(signal!.adx).toBeCloseTo(48.12, 2);
    expect(direction > 0 ? signal!.plusDi : signal!.minusDi).toBeCloseTo(12.42, 2);
    expect(signal!.stop).toBeCloseTo(stop, 1);
    expect(signal!.management).toBe("VWAP_EMA");
    expect(source.funnel.signals).toBe(1);
  });

  it("each trigger candle signals once, and nothing fires before ADX has warmed up", () => {
    const bars = tape(1);
    const source = vwapEmaAdxSignalSource("NIFTY", bars);
    expect(source(27)).not.toBeNull();
    expect(source(27)).toBeNull();
    const early = vwapEmaAdxSignalSource("NIFTY", bars.slice(2)); // 26 bars: ADX(14) needs 28
    expect(early(25)).toBeNull();
    expect(adxSeries(bars.slice(0, 27), 14).at(-1)).toBeNull();
  });
});

// Simulator: a flat 25000 session, the fill at 25000 (no slippage), R = 10 points.
const DAY = Date.parse("2026-09-30T09:15:00+05:30") / 1000;
const session = (overrides: Record<number, Partial<Bar>> = {}): Bar[] =>
  Array.from({ length: 375 }, (_, m) => ({ time: DAY + m * 60, open: 25_000, high: 25_001, low: 24_999, close: 25_000, volume: 100, ...overrides[m] }));
const scalp = (fields: Partial<Signal> = {}): Signal => ({ time: DAY + 21 * 60, side: 1, stop: 24_990, target1: 25_020, strategy: "VWAP-EMA-ADX scalp", reason: "test", confidence: 100, management: "VWAP_EMA", adx: 25, ...fields });
const base = { strategy: "VWAP_EMA_ADX" as const, symbol: "NIFTY", from: "2026-09-30", to: "2026-09-30" };
const flat = { slippagePoints: 0, chargesPerTrade: 0, pnlMode: "POINTS" as const, lotSize: 1, timeStopMinutes: 0 };
const run = (bars: Bar[], signal: Signal, settings: Record<string, unknown> = {}) => runBacktest({ ...base, minute: bars, signalAt: listSignalSource([signal]), settings: { ...flat, ...settings } });

describe("VWAP-EMA-ADX trade management (the live scalper's)", () => {
  it("needs ADX above the threshold on the confirmation candle", () => {
    const blocked = run(session({ 23: { high: 25_025 } }), scalp({ adx: 18.4 }));
    expect(blocked.trades).toHaveLength(0);
    expect(blocked.skipped[0].reason).toMatch(/ADX 18\.4 on the confirmation candle, not above 20/);
    expect(run(session({ 23: { high: 25_025 } }), scalp({ adx: 20 })).trades).toHaveLength(0); // "above 20" is strict
    expect(run(session({ 23: { high: 25_025 } }), scalp({ adx: 18.4 }), { adxMin: 15 }).trades).toHaveLength(1);
  });

  it("re-derives the target from the fill: 1:1 books 1R, 1:2 books 2R", () => {
    const one = run(session({ 23: { high: 25_011 } }), scalp(), { scalpRiskReward: 1 });
    expect(one.trades[0]).toMatchObject({ exitReason: "TARGET", rMultiple: 1, target1: 25_010 });
    // After +1R the stop locks above entry, so price has to hold above it on the way to 2R.
    const two = run(session({ 23: { high: 25_011 }, 24: { open: 25_010, high: 25_012, low: 25_008, close: 25_010 }, 25: { open: 25_012, high: 25_021, low: 25_010, close: 25_018 } }), scalp(), { scalpRiskReward: 2 });
    expect(two.trades[0]).toMatchObject({ exitReason: "TARGET", rMultiple: 2 });
  });

  it("moves to breakeven at +0.5R, then exits on a close back through the 9 EMA", () => {
    const up = { open: 25_005, high: 25_006, low: 25_004, close: 25_005 };
    const bars = session({ 22: up, 23: up, 24: up, 25: up, 26: { open: 25_004, high: 25_005, low: 25_001, close: 25_001.5 } });
    const trade = run(bars, scalp()).trades[0];
    expect(trade.exitReason).toBe("EMA9_LOST");
    expect(trade.points).toBeCloseTo(1.5, 5);
    expect(trade.stopPath[0]).toMatchObject({ price: 25_000, reason: "BREAKEVEN" });
  });

  it("locks +0.5R at +1R and trails 0.6R behind the best price", () => {
    const bars = session({ 22: { open: 25_001, high: 25_012, low: 25_000, close: 25_011 }, 23: { open: 25_010, high: 25_011, low: 25_005, close: 25_006 } });
    const trade = run(bars, scalp()).trades[0];
    expect(trade.exitReason).toBe("TRAILING_STOP");
    expect(trade.exitPrice).toBe(25_006); // 25012 best − 0.6 × 10
    expect(trade.rMultiple).toBeCloseTo(0.6, 5);
  });

  it("covers the round-trip charges and the exit slippage in the breakeven stop", () => {
    // ₹65 charges on 65 units at delta 0.5 = 2 index points, plus 1 point exit slippage = 3.
    const up = { open: 25_006, high: 25_007, low: 25_005, close: 25_006 };
    const slipped = run(session({ 22: up, 23: { open: 25_005, high: 25_006, low: 25_002.5, close: 25_004 } }), scalp({ stop: 24_991 }),
      { pnlMode: "OPTION", delta: 0.5, thetaPerDay: 0, lotSize: 65, chargesPerTrade: 65, slippagePoints: 1 }).trades[0];
    expect(slipped.exitReason).toBe("BREAKEVEN_STOP");
    expect(slipped.exitPrice).toBe(25_003); // stop 25004 (fill 25001 + 3) − 1 point exit slippage
    expect(slipped.pnl).toBeCloseTo(0, 5); // breakeven really is breakeven after charges
  });

  it("covers the round-trip charges in the breakeven stop", () => {
    // ₹65 charges on 65 units at delta 0.5 = 2 index points per unit to cover.
    const up = { open: 25_005, high: 25_006, low: 25_004, close: 25_005 };
    const bars = session({ 22: up, 23: { open: 25_004, high: 25_005, low: 25_001.5, close: 25_003 } });
    const trade = run(bars, scalp(), { pnlMode: "OPTION", delta: 0.5, thetaPerDay: 0, lotSize: 65, chargesPerTrade: 65 }).trades[0];
    expect(trade.exitReason).toBe("BREAKEVEN_STOP");
    expect(trade.exitPrice).toBe(25_002);
  });
});
