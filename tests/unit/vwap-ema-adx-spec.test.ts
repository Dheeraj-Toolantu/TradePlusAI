import { describe, expect, it } from "vitest";
import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { adxSeries } from "../../services/backtest/src/indicators";
import { dataFingerprint, intradayBuyAndHold, specSensitivity, validateMinuteBars } from "../../services/backtest/src/spec-research";
import { DEFAULT_BACKTEST_SETTINGS, listSignalSource, runBacktest, type Signal } from "../../services/backtest/src/strategy-backtest";
import { emaSma, sessionVwap, specSignal, vwapEmaAdxSpecSignalSource } from "../../services/backtest/src/vwap-ema-adx-spec-strategy";

const DAY = Date.parse("2026-10-20T09:15:00+05:30") / 1000;
const flatDay = (start: number, price = 25_000, overrides: Record<number, Partial<Bar>> = {}): Bar[] =>
  Array.from({ length: 375 }, (_, m) => ({ time: start + m * 60, open: price, high: price + 1, low: price - 1, close: price, volume: 100, ...overrides[m] }));
/** A session that ranges for an hour, then trends up 1 point a minute with rising volume. */
function trendDay(start: number, base = 25_000, direction: 1 | -1 = 1): Bar[] {
  let price = base;
  return Array.from({ length: 375 }, (_, m) => {
    const step = m < 60 ? (m % 2 ? 1.5 : -1.5) : direction * (m % 5 === 4 ? -0.6 : 1.4);
    const open = price; const close = price + step; price = close;
    return { time: start + m * 60, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, volume: 1000 + m * 5 };
  });
}

describe("spec v1.0 indicators (section 4)", () => {
  it("EMA uses alpha 2/(n+1), seeded with the SMA of the first n closes", () => {
    const out = emaSma([1, 2, 3, 4, 5, 6], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out[2]).toBe(2); // SMA(1, 2, 3)
    expect(out[3]).toBe(3); // 2 + 0.5 × (4 − 2)
    expect(out[5]).toBe(5);
  });

  it("VWAP resets every session and is undefined without volume (strict) or time-weighted (labelled)", () => {
    const day1 = [{ time: DAY, open: 10, high: 12, low: 8, close: 10, volume: 100 }, { time: DAY + 60, open: 10, high: 22, low: 18, close: 20, volume: 300 }];
    const day2 = [{ time: DAY + 86_400, open: 50, high: 51, low: 49, close: 50, volume: 0 }];
    const strict = sessionVwap([...day1, ...day2], "STRICT");
    expect(strict[0]).toBe(10);
    expect(strict[1]).toBe(17.5); // (10 × 100 + 20 × 300) / 400
    expect(Number.isNaN(strict[2])).toBe(true); // new session, no volume: no carry-over
    expect(sessionVwap([...day1, ...day2], "TIME_WEIGHTED")[2]).toBe(50);
  });

  it("ADX / +DI / −DI follow Wilder and warm up on 2 × 14 candles", () => {
    const bars = trendDay(DAY).slice(0, 120);
    const adx = adxSeries(bars, 14);
    expect(adx[26]).toBeNull();
    expect(adx[27]).not.toBeNull();
    const [value, plus, minus] = adx[119]!;
    expect(value).toBeGreaterThan(25);
    expect(plus).toBeGreaterThan(minus);
  });
});

describe("spec v1.0 signal rules (section 6)", () => {
  const bull = { close: 105, vwap: 100, ema9: 104, ema21: 102, adx: 30, plusDi: 28, minusDi: 12, prevHigh: 104, prevLow: 100 };
  const bear = { close: 95, vwap: 100, ema9: 96, ema21: 98, adx: 30, plusDi: 12, minusDi: 28, prevHigh: 100, prevLow: 96 };
  it("BUY CE and BUY PE when every condition holds", () => {
    expect(specSignal(bull, 25)).toBe(1);
    expect(specSignal(bear, 25)).toBe(-1);
  });
  it.each([
    ["close on VWAP", { close: 100 }], ["EMA9 not above EMA21", { ema9: 102 }], ["ADX equal to the threshold", { adx: 25 }],
    ["+DI not above −DI", { minusDi: 28 }], ["close equal to the previous high", { close: 104 }], ["an invalid indicator", { vwap: Number.NaN }],
  ])("no signal: %s", (_label, change) => {
    expect(specSignal({ ...bull, ...change }, 25)).toBe(0);
  });
});

describe("spec v1.0 signal source (sections 4, 7)", () => {
  const warmup = trendDay(DAY - 86_400 * 3);
  const day = trendDay(DAY, warmup.at(-1)!.close); // no overnight gap
  const minute = [...warmup, ...day];

  it("signals only on completed 5-minute candles, after warm-up, with point-in-time values", () => {
    const source = vwapEmaAdxSpecSignalSource("NIFTY", minute, { timeframe: 5, vwapMode: "STRICT" });
    const fired = minute.map((_, index) => [index, source(index)] as const).filter(([, signal]) => signal);
    expect(fired.length).toBeGreaterThan(0);
    for (const [index, signal] of fired) {
      expect((((minute[index].time + 60 - DAY) % 300) + 300) % 300).toBe(0); // the bar that closes a 5-minute candle
      expect(signal!.time).toBe(minute[index].time + 60); // decided at the candle's close
      expect(signal!.side).toBe(1);
      expect(signal!.adx).toBeGreaterThan(0);
    }
    expect(source.funnel.warmup).toBeGreaterThan(0); // the first candles of the data are warm-up
    expect(source.log[0]).toMatchObject({ side: 1 });
    expect(source.log[0].close).toBeGreaterThan(source.log[0].prevHigh);
  });

  it("gives no signal on sessions without volume when VWAP is strict", () => {
    const silent = minute.map((bar) => ({ ...bar, volume: 0 }));
    const strict = vwapEmaAdxSpecSignalSource("NIFTY", silent, { timeframe: 5, vwapMode: "STRICT" });
    expect(silent.some((_, index) => strict(index))).toBe(false);
    expect(strict.funnel.noVolume).toBeGreaterThan(0);
    const weighted = vwapEmaAdxSpecSignalSource("NIFTY", silent, { timeframe: 5, vwapMode: "TIME_WEIGHTED" });
    expect(silent.some((_, index) => weighted(index))).toBe(true);
  });
});

// Simulator (sections 7–10): flat session at 25000, signal decided at the close of the 09:35 bar
// (minute 20, closing at minute 21); the entry fills at the 09:36 bar's open.
const base = { strategy: "VWAP_EMA_ADX_SPEC" as const, symbol: "NIFTY", from: "2026-10-20", to: "2026-10-20" };
const points = { pnlMode: "POINTS" as const, lotSize: 1, lots: 1, slippagePoints: 0, chargesPerTrade: 0, maxConsecutiveLosses: 20, cooldownMinutes: 0 };
const spec = (fields: Partial<Signal> = {}): Signal => ({ time: DAY + 21 * 60, side: 1, stop: 0, target1: 0, management: "FIXED_POINTS", adx: 30, confidence: 100, strategy: "spec", reason: "test", ...fields });
const run = (bars: Bar[], signals: Signal[], settings: Record<string, unknown> = {}) => runBacktest({ ...base, minute: bars, signalAt: listSignalSource(signals), settings: { ...points, ...settings } });

describe("spec v1.0 execution and exits", () => {
  it("enters at the next candle's open; SL and target are fixed points from that open", () => {
    const bars = flatDay(DAY, 25_000, { 21: { open: 25_002, high: 25_003, low: 25_001, close: 25_002 }, 24: { high: 25_042.5 } });
    const trade = run(bars, [spec()]).trades[0];
    expect(trade.entryTime).toBe(DAY + 21 * 60);
    expect(trade).toMatchObject({ entryPrice: 25_002, stop: 24_982, target1: 25_042, exitReason: "TARGET", points: 40, rMultiple: 2 });
  });

  it("assumes the stop first when one candle touches both", () => {
    const bars = flatDay(DAY, 25_000, { 23: { high: 25_045, low: 24_975 } });
    expect(run(bars, [spec()]).trades[0]).toMatchObject({ exitReason: "SL", points: -20 });
  });

  it("exits at the square-off (EOD) and, as a variant, on the opposite EMA cross", () => {
    expect(run(flatDay(DAY), [spec()]).trades[0]).toMatchObject({ exitReason: "EOD" });
    expect(run(flatDay(DAY), [spec()]).trades[0].exitTime).toBe(DAY + 360 * 60); // close of the 15:14 bar
    const crossing = spec({ exitCheck: (index) => index === 30 });
    expect(run(flatDay(DAY), [crossing], { specEmaExit: true }).trades[0]).toMatchObject({ exitReason: "SIGNAL_EXIT", exitTime: DAY + 31 * 60 });
    expect(run(flatDay(DAY), [crossing]).trades[0].exitReason).toBe("EOD"); // baseline: variant off
  });

  it("needs ADX strictly above the threshold, and charges slippage and fees", () => {
    const bars = flatDay(DAY, 25_000, { 24: { high: 25_050 } });
    expect(run(bars, [spec({ adx: 25 })]).trades).toHaveLength(0);
    expect(run(bars, [spec({ adx: 25 })]).skipped[0].reason).toMatch(/ADX 25\.0 on the signal candle, not above 25/);
    const costed = run(bars, [spec()], { slippagePoints: 1, chargesPerTrade: 50, lotSize: 10 }).trades[0];
    // fill 25001; target 25040 (from the 25000 open) filled 1 pt worse: 25039 → 38 pts × 10 − 50
    expect(costed).toMatchObject({ entryPrice: 25_001, exitReason: "TARGET", points: 38, pnl: 330 });
  });

  it("stops new entries after the daily trade limit and the daily loss limit", () => {
    const bars = flatDay(DAY, 25_000, { 22: { low: 24_970 }, 42: { low: 24_970 } });
    const signals = [spec(), spec({ time: DAY + 40 * 60 }), spec({ time: DAY + 60 * 60 })];
    const capped = run(bars, signals, { maxTradesPerDay: 1 });
    expect(capped.trades).toHaveLength(1);
    expect(capped.skipped.some((item) => item.reason === "Daily trade limit reached")).toBe(true);
    const lossy = run(bars, signals, { maxDailyLoss: 30, lotSize: 2 });
    expect(lossy.trades).toHaveLength(1); // −40 after the first stop: no more entries
    expect(lossy.skipped.some((item) => item.reason === "Daily loss limit reached")).toBe(true);
  });

  it("reconciles the report with the trade ledger", () => {
    const bars = flatDay(DAY, 25_000, { 22: { low: 24_970 }, 44: { high: 25_050 } });
    const result = run(bars, [spec(), spec({ time: DAY + 40 * 60, side: -1 }), spec({ time: DAY + 41 * 60 })]);
    const m = result.metrics;
    expect(m.trades).toBe(result.trades.length);
    expect(m.netPnl).toBeCloseTo(result.trades.reduce((sum, trade) => sum + trade.pnl, 0), 5);
    expect(result.equity.at(-1)!.equity).toBeCloseTo(m.netPnl, 5);
    expect(m.longTrades + m.shortTrades).toBe(m.trades);
    expect(result.segments.byDirection.reduce((sum, row) => sum + row.trades, 0)).toBe(m.trades);
    expect(result.segments.byAdx.map((row) => row.key)).toEqual(["25–30"]);
  });
});

describe("spec v1.0 research tooling (sections 3, 11, 12, 16)", () => {
  it("validates input: sorts, keeps the first of a duplicate, drops bad OHLC, counts missing minutes", () => {
    const bars = flatDay(DAY);
    const messy = [bars[1], bars[0], { ...bars[0], close: 1 }, { ...bars[2], high: bars[2].open - 5 }, ...bars.slice(3, 300)];
    const { bars: clean, quality } = validateMinuteBars(messy, "2026-10-20", "2026-10-20");
    expect(clean[0]).toEqual(bars[0]);
    expect(quality).toMatchObject({ outOfOrder: true, duplicates: 1, invalidOhlc: 1, missingMinutes: 76, sessionsWithGaps: 1 });
    expect(quality.warnings.join(" ")).toMatch(/not filled/);
  });

  it("is reproducible: same input and settings give the same result and fingerprint", () => {
    const minute = [...trendDay(DAY - 86_400 * 3), ...trendDay(DAY)];
    const once = () => {
      const source = vwapEmaAdxSpecSignalSource("NIFTY", minute, { timeframe: 5, vwapMode: "STRICT" });
      return runBacktest({ ...base, minute, signalAt: source, settings: points });
    };
    expect(JSON.stringify(once())).toBe(JSON.stringify(once()));
    expect(dataFingerprint(minute, "2026-10-20", "2026-10-20")).toEqual(dataFingerprint([...minute], "2026-10-20", "2026-10-20"));
    expect(dataFingerprint(minute, "2026-10-20", "2026-10-20").bars).toBe(375);
  });

  it("runs one-at-a-time sensitivity rows and the buy-and-hold baseline", () => {
    const minute = [...trendDay(DAY - 86_400 * 3), ...trendDay(DAY)];
    const settings = { ...DEFAULT_BACKTEST_SETTINGS, ...points };
    const rows = specSensitivity({ ...base, minute, settings, signalsFor: (timeframe) => vwapEmaAdxSpecSignalSource("NIFTY", minute, { timeframe, vwapMode: "STRICT" }) });
    expect([...new Set(rows.map((row) => row.group))]).toEqual(["ADX threshold", "Stop distance", "Reward multiple", "Signal timeframe", "Entry window"]);
    expect(rows.filter((row) => row.baseline).length).toBe(5);
    expect(rows.find((row) => row.label === "No ADX filter (> 0)")!.metrics.trades).toBeGreaterThanOrEqual(rows.find((row) => row.label === "ADX > 25")!.metrics.trades);
    const hold = intradayBuyAndHold({ ...base, minute, settings });
    expect(hold.trades).toBe(1);
    expect(hold.netPnl).toBeGreaterThan(0); // the test day trends up
  });
});
