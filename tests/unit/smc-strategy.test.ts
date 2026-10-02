import { describe, expect, it } from "vitest";
import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { smcSignalSource } from "../../services/backtest/src/smc-strategy";
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

function signalsOf(minute: Bar[]) {
  const source = smcSignalSource("NIFTY", minute, []);
  const out: Array<{ index: number; signal: NonNullable<ReturnType<typeof source>> }> = [];
  for (let index = 0; index < minute.length; index += 1) { const signal = source(index); if (signal) out.push({ index, signal }); }
  return { out, funnel: source.funnel };
}

describe("SMC liquidity-sweep strategy", () => {
  it("fixture bars aggregate to the intended 5m candles", () => {
    const { minute } = scenario();
    const m5 = aggregate(minute.filter((bar) => istDay(bar.time) === "2026-09-22"), 5);
    expect(m5[9]).toMatchObject({ open: 25_097, high: 25_112, low: 25_070, close: 25_090 });
    expect(m5[10]).toMatchObject({ open: 25_090, high: 25_092, low: 25_035, close: 25_040 });
  });

  it("shorts the retrace into the FVG after a PDH sweep and bearish CHoCH, stop beyond the sweep", () => {
    const { minute, triggerTime } = scenario();
    const { out, funnel } = signalsOf(minute);
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

  it("mirrors to a long after a PDL sweep", () => {
    const { minute, triggerTime } = scenario();
    const mirror = (p: number) => 50_000 - p;
    const flipped = minute.map((bar) => ({ ...bar, open: mirror(bar.open), close: mirror(bar.close), high: mirror(bar.low), low: mirror(bar.high) }));
    const { out } = signalsOf(flipped);
    expect(out).toHaveLength(1);
    expect(out[0].signal).toMatchObject({ time: triggerTime, side: 1 });
    expect(out[0].signal.stop).toBeLessThan(mirror(25_112));
    expect(out[0].signal.reason).toMatch(/previous-day low 24,900/);
  });

  it("takes no new entry after 14:30: no time left to reach T2", () => {
    const { minute } = scenario();
    const day2 = at("2026-09-22", "09:15");
    const shift = 265 * 60; // day 2 moved 4h25m later: the 10:17 shooting star now prints at 14:42
    const late = minute.map((bar) => (bar.time >= day2 ? { ...bar, time: bar.time + shift } : bar));
    const { out, funnel } = signalsOf(late.filter((bar) => istDay(bar.time) <= "2026-09-22"));
    expect(out).toHaveLength(0);
    expect(funnel.lateSession).toBe(1);
  });

  it("never places T2 behind an opposing level that T1 has not cleared", () => {
    const { minute } = scenario();
    const { out } = signalsOf(minute);
    const { signal } = out[0];
    const risk = signal.stop - 25_051;
    // Day 1 left equal lows at 24,958 (1.4R away) and the PDL at 24,900. T1 front-runs the equal lows
    // instead of a blind 1.5R, and T2 front-runs the PDL instead of a blind 3R beyond it.
    expect(signal.target1).toBeCloseTo(24_958 + 0.05 * risk, 0);
    expect(signal.target2!).toBeCloseTo(24_900 + 0.05 * risk, 0);
  });

  it("does not trade when price never retraces into the zone", () => {
    const { minute } = scenario();
    const start = at("2026-09-22", "10:15");
    // Replace the retrace with bars that keep falling away from the FVG.
    const noRetrace = minute.map((bar) => (bar.time >= start && bar.time < start + 300 ? { ...bar, open: 25_040, high: 25_044, low: 25_030, close: 25_032 } : bar));
    expect(signalsOf(noRetrace).out).toHaveLength(0);
  });

  it("does not trade when the sweep is accepted (5m close above the level)", () => {
    const { minute } = scenario();
    const start = at("2026-09-22", "10:00");
    const accepted = minute.map((bar) => (bar.time === start + 240 ? { ...bar, close: 25_105, high: 25_112 } : bar));
    expect(signalsOf(accepted).out).toHaveLength(0);
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
