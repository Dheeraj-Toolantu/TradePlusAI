import { describe, expect, it } from "vitest";
import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { orbProSignalSource } from "../../services/backtest/src/orb-pro-strategy";
import { listSignalSource, runBacktest, type Signal } from "../../services/backtest/src/strategy-backtest";

const IST_S = 330 * 60;
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) / 1000 - IST_S;

/** Five 1m bars whose aggregate is exactly the given 5m OHLC. */
function minutesOf(start: number, [o, h, l, c]: number[]): Bar[] {
  const [first, second] = c >= o ? [l, h] : [h, l];
  const points = [o, first, (first + second) / 2, second, (second + c) / 2, c];
  return points.slice(1).map((close, i) => ({ time: start + i * 60, open: points[i], high: Math.max(points[i], close), low: Math.min(points[i], close), close, volume: 0 }));
}

function day(date: string, bars5: number[][], overrides: Record<string, Bar[]> = {}, shift = 0): Bar[] {
  return bars5.flatMap((ohlc, i) => {
    const start = at(date, "09:15") + i * 300;
    const clock = new Date((start + IST_S) * 1000).toISOString().slice(11, 16);
    const bars = overrides[clock] ?? minutesOf(start, ohlc);
    return bars.map((bar) => ({ ...bar, open: bar.open + shift, high: bar.high + shift, low: bar.low + shift, close: bar.close + shift }));
  });
}

/** Day 1: a 24-point-range rotation around 25,000 (ATR ≈ 20; PDH 25,012, PDL 24,986). */
const dayOne = () => Array.from({ length: 75 }, (_, i) => (i % 2 ? [25_002, 25_012, 24_988, 24_998] : [24_998, 25_010, 24_986, 25_002]));

/**
 * Day 2: 15-min OR 24,995–25,020 → 09:35 conviction breakout (close 25,034) → 09:40 accepted above →
 * 09:46 1m retest to 25,021 → 09:47 1m bullish engulfing closes 25,030.
 */
function scenario(options: { shift?: number; weakBreakout?: boolean } = {}) {
  const shift = options.shift ?? 0;
  const retestStart = at("2026-09-22", "09:45");
  const retest: Bar[] = [
    { time: retestStart, open: 25_038, high: 25_038, low: 25_030, close: 25_031, volume: 0 },
    { time: retestStart + 60, open: 25_028, high: 25_029, low: 25_021, close: 25_023, volume: 0 },
    { time: retestStart + 120, open: 25_023, high: 25_031, low: 25_022, close: 25_030, volume: 0 },
    { time: retestStart + 180, open: 25_030, high: 25_034, low: 25_029, close: 25_033, volume: 0 },
    { time: retestStart + 240, open: 25_033, high: 25_036, low: 25_032, close: 25_035, volume: 0 },
  ];
  const breakout = options.weakBreakout ? [25_016, 25_034, 25_014, 25_021] : [25_016, 25_036, 25_015, 25_034];
  const bars5 = [
    [25_000, 25_012, 24_995, 25_010], [25_010, 25_020, 25_004, 25_015], [25_015, 25_018, 25_006, 25_012], // OR 09:15–09:30
    [25_012, 25_019, 25_008, 25_016], breakout, [25_034, 25_040, 25_030, 25_038], [25_038, 25_038, 25_021, 25_035],
    ...Array.from({ length: 68 }, (_, i) => { const p = 25_035 + i * 2; return [p, p + 6, p - 3, p + 2]; }),
  ];
  return [...day("2026-09-21", dayOne(), {}, shift), ...day("2026-09-22", bars5, { "09:45": retest }, shift)];
}

function signals(minute: Bar[]) {
  const source = orbProSignalSource("NIFTY", minute, []);
  const out: Array<{ index: number; signal: Signal }> = [];
  for (let i = 0; i < minute.length; i += 1) { const signal = source(i); if (signal) out.push({ index: i, signal }); }
  return { out, funnel: source.funnel };
}

describe("ORB retest Pro", () => {
  it("enters on the 1m turn after a held retest, with the stop beyond the retest low and the level plus buffer", () => {
    const { out, funnel } = signals(scenario());
    expect(out).toHaveLength(1);
    const { signal } = out[0];
    expect(signal.side).toBe(1);
    expect(signal.time).toBe(at("2026-09-22", "09:48"));
    // Structural: min(retest low 25,021, OR high 25,020) − max(0.15 ATR, 0.03% × 25,030 = 7.51).
    expect(signal.stop).toBeCloseTo(25_020 - 25_030 * 0.0003, 1);
    const risk = 25_030 - signal.stop;
    expect(signal.target1 - 25_030).toBeGreaterThanOrEqual(risk - 0.01);
    expect(signal.target1 - 25_030).toBeLessThanOrEqual(1.5 * risk + 0.01);
    expect(signal.target2!).toBeGreaterThan(signal.target1);
    expect(signal.reason).toMatch(/retest of 25,020 held → 1m engulfing at 25,030/);
    expect(signal.reason).toMatch(/SL 25,012\.5 \(17\.5 pts\): beyond the retest low 25,021 and the OR high 25,020/);
    expect(funnel).toMatchObject({ breakouts: 1, retests: 1, triggers: 1 });
  });

  it("pushes the stop past a round number that sits just beyond it", () => {
    // Shift everything down 11 points: the structural stop lands at 25,001.5, right above 25,000.
    const { out } = signals(scenario({ shift: -11 }));
    expect(out).toHaveLength(1);
    const { signal } = out[0];
    expect(signal.stop).toBeLessThan(25_000);
    expect(signal.stop).toBeGreaterThan(24_995);
    expect(signal.reason).toMatch(/moved past the 25000 round number/);
  });

  it("ignores a wick poke through the range (no body / no outer close)", () => {
    const { out, funnel } = signals(scenario({ weakBreakout: true }));
    expect(out).toHaveLength(0);
    expect(funnel.weakBreakouts).toBeGreaterThan(0);
  });
});

describe("stop path on the trade", () => {
  it("records the move to breakeven at T1 and the trailing stop afterwards", () => {
    const start = at("2026-09-30", "09:15");
    const bars: Bar[] = Array.from({ length: 375 }, (_, m) => ({ time: start + m * 60, open: 25_000, high: 25_001, low: 24_999, close: 25_000 }));
    for (let m = 22; m <= 40; m += 1) { const p = 25_000 + (m - 21) * 50 / 19; bars[m] = { time: bars[m].time, open: p - 1, high: p + 0.5, low: p - 1.5, close: p }; }
    for (let m = 41; m < 375; m += 1) bars[m] = { time: bars[m].time, open: 25_030, high: 25_031, low: 25_029, close: 25_030 };
    const signal: Signal = { time: start + 21 * 60, side: 1, stop: 24_990, target1: 25_015, target2: 25_020, strategy: "t", reason: "t", confidence: 80 };
    const trade = runBacktest({ strategy: "ORB_PRO", symbol: "NIFTY", from: "2026-09-30", to: "2026-09-30", minute: bars, signalAt: listSignalSource([signal]), settings: { pnlMode: "POINTS", chargesPerTrade: 0, slippagePoints: 0, lotSize: 1, trailR: 1, timeStopMinutes: 0 } }).trades[0];
    expect(trade.stopPath[0]).toMatchObject({ reason: "BREAKEVEN", price: 25_000 });
    expect(trade.stopPath.slice(1).every((move) => move.reason === "TRAIL")).toBe(true);
    const prices = trade.stopPath.map((move) => move.price);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices); // a long's stop only ever moves up
    expect(prices.at(-1)).toBeCloseTo(25_040.5, 1); // best high 25,050.5 − 1R
  });
});
