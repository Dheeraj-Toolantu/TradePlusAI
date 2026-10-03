import { describe, expect, it } from "vitest";
import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { smcSignalSource, type SmcOptions } from "../../services/backtest/src/smc-strategy";
import { aggregate, istDay, runBacktest } from "../../services/backtest/src/strategy-backtest";
import { syntheticSessions } from "../../services/backtest/src/synthetic-market";

const IST_S = 330 * 60;
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) / 1000 - IST_S;

/** Five 1m bars whose aggregate is exactly the given 5m OHLC (open → first extreme → second → close). */
function minutesOf(start: number, [o, h, l, c]: number[]): Bar[] {
  const [first, second] = c >= o ? [l, h] : [h, l];
  const points = [o, first, (first + second) / 2, second, (second + c) / 2, c];
  return points.slice(1).map((close, index) => {
    const open = points[index];
    return { time: start + index * 60, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0 };
  });
}

function session(day: string, bars5: number[][], overrides: Record<string, Bar[]> = {}): Bar[] {
  return bars5.flatMap((ohlc, index) => {
    const start = at(day, "09:15") + index * 300;
    const clock = new Date((start + IST_S) * 1000).toISOString().slice(11, 16);
    return overrides[clock] ?? minutesOf(start, ohlc);
  });
}

/** Day 1: a choppy 24,950–25,000 range with one spike to 25,100 (PDH) and one to 24,900 (PDL), ~32-pt bars. */
function dayOne(): number[][] {
  return Array.from({ length: 75 }, (_, index) => {
    const base = 24_960 + (index % 4) * 8;
    if (index === 21) return [base, 25_100, base - 10, base + 5];
    if (index === 45) return [base, base + 10, 24_900, base - 5];
    return index % 2 ? [base + 16, base + 30, base - 2, base] : [base, base + 30, base - 2, base + 16];
  });
}

/**
 * Day 2: opening range 25,040–25,075, a clean rally into PDH, a 10:00 sweep of PDH (wick to 25,112,
 * close back at 25,090), a 10:05 bearish displacement to 25,035, a 10:10 bar leaving an FVG
 * (25,055–25,070), then a 10:17 shooting star inside the FVG.
 */
function dayTwo(): { bars: Bar[]; triggerTime: number } {
  const day = "2026-09-22";
  const bars5 = [
    [25_050, 25_075, 25_045, 25_070], [25_070, 25_074, 25_040, 25_046], [25_046, 25_072, 25_042, 25_066], // OR 09:15-09:30
    [25_066, 25_078, 25_064, 25_077], [25_077, 25_084, 25_075, 25_083], [25_083, 25_088, 25_081, 25_087],
    [25_087, 25_092, 25_085, 25_091], [25_091, 25_096, 25_089, 25_095], [25_095, 25_098, 25_093, 25_097], // 09:30-10:00 rally
    [25_097, 25_112, 25_070, 25_090], // 10:00 sweep of PDH
    [25_090, 25_092, 25_035, 25_040], // 10:05 displacement (CHoCH)
    [25_040, 25_055, 25_030, 25_045], // 10:10 completes the FVG 25,055–25,070
    [25_045, 25_066, 25_040, 25_051], // 10:15 retrace into the FVG
    ...Array.from({ length: 62 }, (_, index) => { const p = 25_040 - index * 3; return [p, p + 6, p - 8, p - 3]; }),
  ];
  const t = at(day, "10:15");
  const trigger: Bar[] = [
    { time: t, open: 25_045, high: 25_053, low: 25_040, close: 25_052, volume: 0 },
    { time: t + 60, open: 25_052, high: 25_058, low: 25_050, close: 25_057, volume: 0 },
    { time: t + 120, open: 25_057, high: 25_066, low: 25_050, close: 25_051, volume: 0 }, // shooting star in the FVG
    { time: t + 180, open: 25_051, high: 25_052, low: 25_046, close: 25_048, volume: 0 },
    { time: t + 240, open: 25_048, high: 25_050, low: 25_044, close: 25_051, volume: 0 },
  ];
  return { bars: session(day, bars5, { "10:15": trigger }), triggerTime: t + 180 };
}

function scenario() {
  const { bars, triggerTime } = dayTwo();
  return { minute: [...session("2026-09-21", dayOne()), ...bars], triggerTime };
}

/**
 * v2 scenario: the same day-2 sweep → CHoCH → FVG retrace, but inside a 15m DOWNTREND. Day 1 trades
 * 300 points higher, so day 2 opens below it and the 15m 9 EMA is falling above price. The opening
 * range high (25,105, a 5m swing high) is buy-side liquidity; the 10:00 bar sweeps it (wick to 25,112,
 * close 25,090), the 10:05 displacement closes through the 09:20 swing low. At 10:16 a 1m bar taps the FVG, at 10:17 a bearish 1m candle closes back below it.
 */
function trendScenario() {
  const day = "2026-09-22";
  const { bars, triggerTime } = dayTwo();
  const openingRange: Record<string, number[]> = {
    "09:15": [25_050, 25_075, 25_045, 25_070], "09:20": [25_070, 25_074, 25_040, 25_046], "09:25": [25_046, 25_105, 25_042, 25_066],
    "09:30": [25_066, 25_078, 25_064, 25_077], "09:35": [25_077, 25_084, 25_075, 25_083],
    // The displacement closes through the 09:20 swing low (25,040): a CHoCH.
    "10:05": [25_090, 25_092, 25_030, 25_032],
  };
  const replaced = Object.entries(openingRange).flatMap(([clock, ohlc]) => minutesOf(at(day, clock), ohlc));
  const day2 = bars.filter((bar) => bar.time >= at(day, "09:40") && (bar.time < at(day, "10:05") || bar.time >= at(day, "10:10"))).concat(replaced).sort((a, b) => a.time - b.time);
  const day1 = session("2026-09-21", dayOne()).map((bar) => ({ ...bar, open: bar.open + 300, high: bar.high + 300, low: bar.low + 300, close: bar.close + 300 }));
  return { minute: [...day1, ...day2], triggerTime };
}

function signalsOf(minute: Bar[], options: SmcOptions = {}) {
  const source = smcSignalSource("NIFTY", minute, [], options);
  const out: Array<{ index: number; signal: NonNullable<ReturnType<typeof source>> }> = [];
  for (let index = 0; index < minute.length; index += 1) { const signal = source(index); if (signal) out.push({ index, signal }); }
  return { out, funnel: source.funnel };
}

/**
 * CHoCH-retest scenario: day 1 trades 150 points lower, so the 15m 9 EMA rises under day 2. Day 2 rallies to
 * 25,075 (higher high over 25,045, higher low 25,012), then a 5m pullback closes below 25,012 (5m structure
 * turns bearish) and makes a lower high at 25,050. At 10:25 a displacement candle closes back through
 * 25,050: a bullish CHoCH with the 15m trend. 10:30 leaves an FVG 25,036–25,070; price taps it at 10:42 and
 * the 10:43 1m candle closes strongly back above 25,070.
 */
function chochScenario() {
  const day = "2026-09-22";
  const bars5 = [
    [25_000, 25_012, 24_995, 25_010], [25_010, 25_030, 25_008, 25_028], [25_028, 25_045, 25_025, 25_040], // 09:15 swing high 25,045 at 09:25
    [25_040, 25_042, 25_020, 25_024], [25_024, 25_028, 25_012, 25_018], [25_018, 25_040, 25_016, 25_038], // higher low 25,012 at 09:35
    [25_038, 25_060, 25_035, 25_058], [25_058, 25_075, 25_055, 25_070], [25_070, 25_072, 25_040, 25_044], // higher high 25,075 at 09:50
    [25_044, 25_046, 25_006, 25_008], // 10:00 closes below 25,012: 5m structure bearish
    [25_008, 25_020, 25_006, 25_016], [25_016, 25_050, 25_012, 25_040], [25_040, 25_044, 25_026, 25_030], [25_030, 25_036, 25_022, 25_028], // lower high 25,050 at 10:10
    [25_028, 25_090, 25_026, 25_086], // 10:25 bullish CHoCH through 25,050
    [25_086, 25_130, 25_070, 25_125], // 10:30 completes the FVG 25,036–25,070
    [25_125, 25_128, 25_090, 25_095], [25_095, 25_098, 25_066, 25_080], // 10:42 tap, 10:43 strong close back above
    ...Array.from({ length: 57 }, (_, index) => { const p = 25_082 + index * 2; return [p, p + 8, p - 4, p + 2]; }),
  ];
  const day1 = session("2026-09-21", dayOne()).map((bar) => ({ ...bar, open: bar.open - 150, high: bar.high - 150, low: bar.low - 150, close: bar.close - 150 }));
  return { minute: [...day1, ...session(day, bars5)], triggerTime: at(day, "10:43") + 60 };
}

describe("SMC liquidity-sweep strategy", () => {
  it("fixture bars aggregate to the intended 5m candles", () => {
    const { minute } = scenario();
    const m5 = aggregate(minute.filter((bar) => istDay(bar.time) === "2026-09-22"), 5);
    expect(m5[9]).toMatchObject({ open: 25_097, high: 25_112, low: 25_070, close: 25_090 });
    expect(m5[10]).toMatchObject({ open: 25_090, high: 25_092, low: 25_035, close: 25_040 });
  });

  it("legacy: shorts the retrace into the FVG after a PDH sweep and bearish CHoCH, stop beyond the sweep", () => {
    const { minute, triggerTime } = scenario();
    const { out, funnel } = signalsOf(minute, { legacy: true });
    expect(out).toHaveLength(1);
    const { signal } = out[0];
    expect(signal.time).toBe(triggerTime);
    expect(signal.side).toBe(-1);
    expect(signal.stop).toBeGreaterThan(25_112);
    expect(signal.stop).toBeLessThan(25_125);
    const entry = 25_051;
    const risk = signal.stop - entry;
    expect(entry - signal.target1).toBeGreaterThanOrEqual(risk * 0.99);
    expect(entry - signal.target1).toBeLessThanOrEqual(risk * 1.51);
    expect(signal.target2!).toBeLessThan(signal.target1);
    expect(signal.reason).toMatch(/previous-day high 25,100/);
    expect(signal.reason).toMatch(/CHoCH/);
    expect(signal.reason).toMatch(/FVG/);
    expect(signal.reason).toMatch(/engulfing|shooting-star/);
    expect(signal.confidence).toBeGreaterThanOrEqual(60);
    expect(funnel).toMatchObject({ choch: 1, zones: 1, entries: 1 });
  });

  it("legacy: mirrors to a long after a PDL sweep", () => {
    const { minute, triggerTime } = scenario();
    const mirror = (p: number) => 50_000 - p;
    const flipped = minute.map((bar) => ({ ...bar, open: mirror(bar.open), close: mirror(bar.close), high: mirror(bar.low), low: mirror(bar.high) }));
    const { out } = signalsOf(flipped, { legacy: true });
    expect(out).toHaveLength(1);
    expect(out[0].signal).toMatchObject({ time: triggerTime, side: 1 });
    expect(out[0].signal.stop).toBeLessThan(mirror(25_112));
    expect(out[0].signal.reason).toMatch(/previous-day low 24,900/);
  });

  it("takes no new entry after 14:30: no time left to reach T2", () => {
    const { minute } = trendScenario();
    const day2 = at("2026-09-22", "09:15");
    const shift = 265 * 60; // day 2 moved 4h25m later: the 10:17 shooting star now prints at 14:42
    const late = minute.map((bar) => (bar.time >= day2 ? { ...bar, time: bar.time + shift } : bar));
    const { out, funnel } = signalsOf(late.filter((bar) => istDay(bar.time) <= "2026-09-22"));
    expect(out).toHaveLength(0);
    expect(funnel.lateSession).toBe(1);
  });

  it("legacy: never places T2 behind an opposing level that T1 has not cleared", () => {
    const { minute } = scenario();
    const { out } = signalsOf(minute, { legacy: true });
    const { signal } = out[0];
    const risk = signal.stop - 25_051;
    // Day 1 left equal lows at 24,958 (1.4R away) and the PDL at 24,900. T1 front-runs the equal lows
    // instead of a blind 1.5R, and T2 front-runs the PDL instead of a blind 3R beyond it.
    expect(signal.target1).toBeCloseTo(24_958 + 0.05 * risk, 0);
    expect(signal.target2!).toBeCloseTo(24_900 + 0.05 * risk, 0);
  });

  it("does not trade when price never retraces into the zone", () => {
    const { minute } = trendScenario();
    const start = at("2026-09-22", "10:15");
    // Replace the retrace with bars that keep falling away from the FVG.
    const noRetrace = minute.map((bar) => (bar.time >= start && bar.time < start + 300 ? { ...bar, open: 25_040, high: 25_044, low: 25_030, close: 25_032 } : bar));
    expect(signalsOf(noRetrace).out).toHaveLength(0);
  });

  it("does not trade when the sweep is accepted (5m close above the level)", () => {
    const { minute } = trendScenario();
    const start = at("2026-09-22", "10:00");
    const accepted = minute.map((bar) => (bar.time === start + 240 ? { ...bar, close: 25_105, high: 25_112 } : bar));
    expect(signalsOf(accepted).out).toHaveLength(0);
  });

  it("v2: shorts the FVG retrace after an ORH sweep when the 15m 9 EMA is falling, T1 at 1R", () => {
    const { minute, triggerTime } = trendScenario();
    const { out, funnel } = signalsOf(minute);
    expect(out).toHaveLength(1);
    const { signal } = out[0];
    expect(signal.time).toBe(triggerTime);
    expect(signal.side).toBe(-1);
    expect(signal.stop).toBeGreaterThan(25_112);
    expect(signal.stop).toBeLessThan(25_125);
    const entry = 25_051;
    const risk = signal.stop - entry;
    expect(entry - signal.target1).toBeCloseTo(risk, 0);
    expect(signal.target2!).toBeLessThan(signal.target1);
    expect(signal.reason).toMatch(/opening-range high 25,105/);
    expect(signal.reason).toMatch(/1m close back below the zone/);
    expect(signal.reason).toMatch(/15m 9 EMA falling/);
    expect(signal.reason).toMatch(/below VWAP/);
    expect(signal.confidence).toBeGreaterThanOrEqual(60);
    expect(funnel).toMatchObject({ choch: 1, zones: 1, entries: 1 });
  });

  it("v2: mirrors to a long when the 15m 9 EMA is rising", () => {
    const { minute, triggerTime } = trendScenario();
    const mirror = (p: number) => 50_000 - p;
    const flipped = minute.map((bar) => ({ ...bar, open: mirror(bar.open), close: mirror(bar.close), high: mirror(bar.low), low: mirror(bar.high) }));
    const { out } = signalsOf(flipped);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toMatchObject({ time: triggerTime, side: 1 });
    expect(out[0].signal.reason).toMatch(/15m 9 EMA rising/);
  });

  it("v2: does not short a sweep while the 15m 9 EMA is still rising (counter-trend)", () => {
    const { minute, triggerTime } = scenario();
    const { out } = signalsOf(minute);
    expect(out.filter(({ signal }) => signal.time === triggerTime)).toHaveLength(0);
    for (const { signal } of out) expect(signal.reason).toMatch(/15m 9 EMA falling/);
  });

  it("v2: waits for a 1m close back out of the zone; a wick alone is not a trigger", () => {
    const { minute, triggerTime } = trendScenario();
    // The 10:17 candle still wicks into the FVG but closes inside it (25,058): no confirmation yet.
    const unconfirmed = minute.map((bar) => (bar.time + 60 === triggerTime ? { ...bar, close: 25_058, low: 25_050 } : bar));
    const { out } = signalsOf(unconfirmed);
    expect(out.every(({ signal }) => signal.time > triggerTime)).toBe(true);
  });

  it("CHoCH retest: buys the FVG retest after the 5m pullback's CHoCH in the 15m 9 EMA uptrend", () => {
    const { minute, triggerTime } = chochScenario();
    const { out, funnel } = signalsOf(minute, { chochRetest: true });
    const choch = out.filter(({ signal }) => signal.strategy === "SMC CHoCH retest");
    expect(choch).toHaveLength(1);
    const { signal } = choch[0];
    expect(signal.time).toBe(triggerTime);
    expect(signal.side).toBe(1);
    expect(signal.stop).toBeLessThan(25_006); // beyond the impulse leg's origin
    expect(signal.stop).toBeGreaterThan(24_990);
    expect(signal.target1 - 25_073).toBeCloseTo(25_073 - signal.stop, 0); // T1 = 1R
    expect(signal.reason).toMatch(/bullish CHoCH through the swing 25,050/);
    expect(signal.reason).toMatch(/strong close/);
    expect(signal.reason).toMatch(/15m 9 EMA rising/);
    expect(funnel.chochEntries).toBe(1);
  });

  it("CHoCH retest: needs a strong 1m close, not just any close back out of the zone", () => {
    const { minute, triggerTime } = chochScenario();
    // 10:43 still closes above the FVG (25,071) but in the lower half of its range: not a strong close.
    const weak = minute.map((bar) => (bar.time + 60 === triggerTime ? { ...bar, high: 25_080, close: 25_071 } : bar));
    const { out } = signalsOf(weak, { chochRetest: true });
    expect(out.filter(({ signal }) => signal.strategy === "SMC CHoCH retest" && signal.time === triggerTime)).toHaveLength(0);
  });

  it("CHoCH retest: a break in the direction the 5m structure already had (BOS) is not traded", () => {
    const { minute } = chochScenario();
    // Without the 10:00–10:10 dip below the higher low, the 10:25 break continues a bullish 5m structure.
    const noFlip = minute.map((bar) => (bar.time >= at("2026-09-22", "10:00") && bar.time < at("2026-09-22", "10:10") ? { ...bar, low: Math.max(bar.low, 25_014), close: Math.max(bar.close, 25_014), open: Math.max(bar.open, 25_014) } : bar));
    expect(signalsOf(noFlip, { chochRetest: true }).out.filter(({ signal }) => signal.strategy === "SMC CHoCH retest")).toHaveLength(0);
  });

  it("CHoCH retest entries are off by default", () => {
    const { minute } = chochScenario();
    expect(signalsOf(minute).out.filter(({ signal }) => signal.strategy === "SMC CHoCH retest")).toHaveLength(0);
  });

  it("is causal: signals on truncated data match signals on the full data", () => {
    const { minute, daily } = syntheticSessions("2026-03-02", "2026-06-30", { seed: 5 });
    const full = signalsOf(minute).out;
    expect(full.length).toBeGreaterThan(0);
    for (const { index, signal } of full.slice(0, 8)) {
      const cut = minute.slice(0, index + 1);
      const source = smcSignalSource("NIFTY", cut, daily);
      let last = null;
      for (let k = 0; k <= index; k += 1) last = source(k);
      expect(last).toEqual(signal);
    }
  });

  it("runs a six-month walk-forward backtest quickly", () => {
    const { minute, daily } = syntheticSessions("2026-02-02", "2026-09-30", { seed: 21 });
    const started = Date.now();
    const result = runBacktest({ strategy: "SMC_SWEEP", symbol: "NIFTY", from: "2026-04-01", to: "2026-09-30", minute, signalAt: smcSignalSource("NIFTY", minute, daily), settings: { timeStopMinutes: 30 } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.daily.length).toBeGreaterThan(120);
    for (const trade of result.trades) {
      expect(trade.strategy).toBe("SMC liquidity sweep");
      expect((trade.entryPrice - trade.stop) * (trade.side === "LONG" ? 1 : -1)).toBeGreaterThan(0);
    }
  });
});
