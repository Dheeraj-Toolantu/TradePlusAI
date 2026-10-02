import { describe, expect, it } from "vitest";
import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { aggregate, istDay, listSignalSource, mtfSignalSource, runBacktest, type Signal } from "../../services/backtest/src/strategy-backtest";
import { syntheticSessions } from "../../services/backtest/src/synthetic-market";

const DAY_START = Date.parse("2026-09-30T09:15:00+05:30") / 1000;
/** Flat 1-minute session at 25000 with optional overrides per minute index. */
function session(overrides: Record<number, Partial<Bar>> = {}, start = DAY_START, price = 25_000): Bar[] {
  return Array.from({ length: 375 }, (_, m) => ({ time: start + m * 60, open: price, high: price + 1, low: price - 1, close: price, volume: 100, ...overrides[m] }));
}
const at = (m: number, start = DAY_START) => start + m * 60 + 60; // decision time at the close of minute m
const signal = (m: number, fields: Partial<Signal> = {}, start = DAY_START): Signal => ({ time: at(m, start), side: 1, stop: 24_990, target1: 25_020, target2: 25_030, strategy: "test", reason: "test", confidence: 80, ...fields });
const minute25 = 20; // 09:35 bar closes at 09:36
/** T1 hit 3 bars after the fill, price then holds above entry until T2 prints 3 bars later. */
const runner = () => { const o: Record<number, Partial<Bar>> = { [minute25 + 3]: { high: 25_021 } }; for (let m = minute25 + 4; m < minute25 + 7; m += 1) o[m] = { open: 25_015, high: 25_016, low: 25_012, close: 25_015 }; o[minute25 + 6] = { open: 25_015, high: 25_031, low: 25_012, close: 25_030 }; return o; };
const base = { strategy: "MTF_AI" as const, symbol: "NIFTY", from: "2026-09-30", to: "2026-09-30" };
const flat = { slippagePoints: 0, chargesPerTrade: 0, pnlMode: "POINTS" as const, lotSize: 1, timeStopMinutes: 0 };

describe("trade simulator", () => {
  it("fills at the next bar's open, books half at T1, moves the stop to entry and exits the rest at T2", () => {
    const bars = session(runner());
    const result = runBacktest({ ...base, minute: bars, signalAt: listSignalSource([signal(minute25)]), settings: flat });
    const trade = result.trades[0];
    expect(trade.entryPrice).toBe(25_000);
    expect(trade.entryTime).toBe(bars[minute25 + 1].time);
    expect(trade.legs.map((leg) => [leg.reason, leg.price, leg.fraction])).toEqual([["TARGET_1", 25_020, 0.5], ["TARGET_2", 25_030, 0.5]]);
    expect(trade.points).toBe(25);
    expect(trade.rMultiple).toBe(2.5);
    expect(result.metrics.netPnl).toBe(25);
  });

  it("assumes the stop first when one bar touches both stop and target, and fills a gap at the open", () => {
    const both = runBacktest({ ...base, minute: session({ [minute25 + 2]: { high: 25_025, low: 24_985 } }), signalAt: listSignalSource([signal(minute25)]), settings: flat });
    expect(both.trades[0].exitReason).toBe("STOP_LOSS");
    expect(both.trades[0].points).toBe(-10);
    const gap = runBacktest({ ...base, minute: session({ [minute25 + 2]: { open: 24_980, high: 24_981, low: 24_970, close: 24_975 } }), signalAt: listSignalSource([signal(minute25)]), settings: flat });
    expect(gap.trades[0].exitPrice).toBe(24_980);
  });

  it("still delivers a list signal when the exact 1-minute bar is missing, but refuses a stale fill after a gap", () => {
    // The 09:36 bar is missing: the signal stamped 09:36 arrives on the 09:37 close and fills at 09:37.
    const holed = session(runner()).filter((_, m) => m !== minute25);
    const result = runBacktest({ ...base, minute: holed, signalAt: listSignalSource([signal(minute25)]), settings: flat });
    expect(result.trades).toHaveLength(1);
    expect(result.signalsSeen).toBe(1);
    // A 5-minute hole after the decision: the next bar is too late to fill at the planned price.
    const gapped = session().filter((_, m) => m < minute25 + 1 || m > minute25 + 5);
    const late = runBacktest({ ...base, minute: gapped, signalAt: listSignalSource([signal(minute25)]), settings: flat });
    expect(late.trades).toHaveLength(0);
    expect(late.skipped.map((item) => item.reason)).toContain("Data gap before the fill");
  });

  it("passes on a fill that has already run to T1 instead of booking a fake target hit", () => {
    // The next bar opens at 25,018: only 2 of the 20 points to T1 are left against 28 points of risk.
    const bars = session({ [minute25 + 1]: { open: 25_018, high: 25_019, low: 25_017, close: 25_018 } });
    const result = runBacktest({ ...base, minute: bars, signalAt: listSignalSource([signal(minute25)]), settings: flat });
    expect(result.trades).toHaveLength(0);
    expect(result.skipped.map((item) => item.reason)).toContain("Fill too close to T1 (reward under 0.5R)");
  });

  it("applies the time stop and the 15:15 square-off", () => {
    const timeStopped = runBacktest({ ...base, minute: session(), signalAt: listSignalSource([signal(minute25)]), settings: { ...flat, timeStopMinutes: 15 } });
    expect(timeStopped.trades[0].exitReason).toBe("TIME_STOP");
    expect(timeStopped.trades[0].holdMinutes).toBe(15);
    const late = runBacktest({ ...base, minute: session(), signalAt: listSignalSource([signal(320, { stop: 24_900, target1: 25_200 })]), settings: { ...flat, entryEnd: "15:00" } });
    expect(late.trades[0].exitReason).toBe("SQUARE_OFF");
    expect(new Date((late.trades[0].exitTime + 330 * 60) * 1000).toISOString().slice(11, 16)).toBe("15:15");
  });

  it("enforces one position at a time, the cooldown, consecutive-loss stop and confidence threshold", () => {
    // Loss at 09:38; a signal 5 minutes later is in the cooldown; after 2 losses the day stops.
    const bars = session({ [minute25 + 2]: { low: 24_980 }, [minute25 + 22]: { low: 24_980 } });
    const signals = [signal(minute25), signal(minute25 + 1), signal(minute25 + 7), signal(minute25 + 20), signal(minute25 + 40), signal(minute25 + 60, { confidence: 30 })];
    const result = runBacktest({ ...base, minute: bars, signalAt: listSignalSource(signals), settings: { ...flat, cooldownMinutes: 10, maxConsecutiveLosses: 2, minConfidence: 60 } });
    expect(result.trades).toHaveLength(2);
    const reasons = result.skipped.map((item) => item.reason);
    expect(reasons).toContain("Cooling down after a loss");
    expect(reasons).toContain("Consecutive-loss stop for the day");
    expect(result.metrics.maxConsecutiveLosses).toBe(2);
  });

  it("estimates option P&L from delta, time decay and charges", () => {
    const bars = session(runner());
    const result = runBacktest({ ...base, minute: bars, signalAt: listSignalSource([signal(minute25)]), settings: { ...flat, pnlMode: "OPTION", delta: 0.5, thetaPerDay: 37.5, lotSize: 10, lots: 2, chargesPerTrade: 50 } });
    // 25 pts x 0.5 delta = 12.5 premium pts; decay 37.5 pts/day x 6/375 day = 0.6; x 20 units - 50 charges
    expect(result.trades[0].pnl).toBeCloseTo((12.5 - 0.6) * 20 - 50, 5);
  });
});

describe("walk-forward data handling", () => {
  it("aggregates 1-minute bars onto the 09:15 session grid", () => {
    const five = aggregate(session({ 2: { high: 25_050 }, 7: { low: 24_900 } }), 5);
    expect(five).toHaveLength(75);
    expect(new Date((five[0].time + 330 * 60) * 1000).toISOString().slice(11, 16)).toBe("09:15");
    expect(five[0].high).toBe(25_050);
    expect(five[1].low).toBe(24_900);
    expect(five[0].volume).toBe(500);
  });

  it("replays the multi-timeframe strategy end to end on synthetic sessions without look-ahead", { timeout: 30_000 }, () => {
    const { minute, daily } = syntheticSessions("2026-07-20", "2026-09-30");
    const bars = minute.filter((bar) => istDay(bar.time) >= "2026-09-24");
    const result = runBacktest({ ...base, from: "2026-09-28", to: "2026-09-30", minute: bars, signalAt: mtfSignalSource("NIFTY", bars, daily) });
    expect(result.metrics.tradingDays).toBe(3);
    for (const trade of result.trades) {
      expect(trade.entryTime).toBeGreaterThanOrEqual(trade.signalTime); // fills only after the decision bar closed
      expect(trade.day >= "2026-09-28" && trade.day <= "2026-09-30").toBe(true);
    }
    const tradesPerDay = new Map<string, number>();
    for (const trade of result.trades) tradesPerDay.set(trade.day, (tradesPerDay.get(trade.day) ?? 0) + 1);
    expect(Math.max(0, ...tradesPerDay.values())).toBeLessThanOrEqual(3);
  });
});
