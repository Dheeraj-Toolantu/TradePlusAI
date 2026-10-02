import { describe, expect, it } from "vitest";
import { analyzeMultiTimeframe, atr, blackScholes, completedBars, detectPatterns, rsi, valueOption, type Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { bullishStack, MTF_NOW } from "../fixtures/mtf-candles";

const candidates = { CE: { side: "CE" as const, trading_symbol: "NIFTY24900CE", strike: 24900, premium: 60, delta: 0.5 }, PE: { side: "PE" as const, trading_symbol: "NIFTY24900PE", strike: 24900, premium: 55, delta: -0.5 } };
const run = (stack: ReturnType<typeof bullishStack>, now = MTF_NOW, spot = stack.spot) => analyzeMultiTimeframe({ symbol: "NIFTY", spot, candles: stack, candidates, atmIv: 13, expiry: "2026-10-01", now });

describe("multi-timeframe decision engine", () => {
  it("buys CE when 1D/15m/5m/1m align bullish and a 1m engulfing confirms at value", () => {
    const decision = run(bullishStack(1));
    expect(decision.action).toBe("BUY_CE");
    expect(decision.alignment).toBe("BULLISH_ALIGNED");
    expect(decision.confidence).toBeGreaterThanOrEqual(60);
    const plan = decision.spot!;
    expect(plan.stop).toBeLessThan(plan.entry);
    expect(plan.target1).toBeCloseTo(plan.entry + 2 * plan.riskPoints, 1);
    expect(plan.target2).toBeGreaterThan(plan.target1);
    expect(decision.reasons.join(" ")).toMatch(/1m trigger: Bullish engulfing/);
    expect(decision.exitPlan.join(" ")).toMatch(/15:15/);
    expect(decision.psychology.length).toBeGreaterThan(0);
  });

  it("buys PE on the mirrored bearish stack", () => {
    const decision = run(bullishStack(-1));
    expect(decision.action).toBe("BUY_PE");
    expect(decision.spot!.stop).toBeGreaterThan(decision.spot!.entry);
    expect(decision.spot!.target1).toBeLessThan(decision.spot!.entry);
  });

  it("refuses to chase a move that is far from the 5m EMA20", () => {
    const stack = bullishStack(1);
    const decision = run(stack, MTF_NOW, stack.spot + 400);
    expect(decision.action).toBe("WAIT");
    expect(decision.headline).toMatch(/chasing|room|between levels/i);
  });

  it("waits when the 15m trend disagrees with the lower timeframes", () => {
    const bull = bullishStack(1);
    const bear = bullishStack(-1);
    const decision = run({ ...bull, "15m": bear["15m"] });
    expect(decision.action).toBe("WAIT");
    expect(decision.alignment).not.toBe("BULLISH_ALIGNED");
  });

  it("never trades in the first 15 minutes after the open", () => {
    const stack = bullishStack(1);
    const open = new Date("2026-09-30T03:52:00Z"); // 09:22 IST
    const shifted = Object.fromEntries(Object.entries(stack).map(([key, value]) => [key, Array.isArray(value) ? value.map((bar) => ({ ...bar, time: bar.time - (MTF_NOW.getTime() - open.getTime()) / 1000 })) : value])) as typeof stack;
    const decision = run(shifted, open);
    expect(decision.action).toBe("WAIT");
  });

  it("reports insufficient data instead of guessing", () => {
    const decision = analyzeMultiTimeframe({ symbol: "NIFTY", spot: 25000, candles: { "1m": bullishStack(1)["1m"] }, now: MTF_NOW });
    expect(decision.action).toBe("WAIT");
    expect(decision.alignment).toBe("INSUFFICIENT_DATA");
  });
});

describe("closed candles only", () => {
  it("drops the forming intraday candle and today's daily bar", () => {
    const nowS = MTF_NOW.getTime() / 1000;
    const bars: Bar[] = [{ time: nowS - 600, open: 1, high: 2, low: 0.5, close: 1.5 }, { time: nowS - 200, open: 1.5, high: 2, low: 1, close: 1.8 }];
    expect(completedBars(bars, "5m", MTF_NOW)).toHaveLength(1);
    const daily: Bar[] = [{ time: nowS - 86_400, open: 1, high: 2, low: 0.5, close: 1.5 }, { time: nowS - 3600, open: 1.5, high: 2, low: 1, close: 1.8 }];
    expect(completedBars(daily, "1D", MTF_NOW)).toHaveLength(1);
  });
});

describe("candlestick psychology", () => {
  const bar = (open: number, high: number, low: number, close: number, volume = 100): Bar => ({ time: 0, open, high, low, close, volume });
  it("detects a hammer after a decline and strengthens it at support", () => {
    const decline = [bar(110, 111, 107, 108), bar(108, 109, 105, 106), bar(106, 107, 103, 104), bar(104, 105, 101, 102), bar(102, 103, 99, 100), bar(100, 101, 97, 98)];
    const hammer = bar(98, 98.6, 93, 98.4);
    const patterns = detectPatterns([...decline, hammer], [{ label: "Previous day low", price: 93.2, kind: "SUPPORT" }], 4);
    const found = patterns.find((pattern) => pattern.name === "Hammer");
    expect(found?.bias).toBe("BULLISH");
    expect(found?.atLevel).toBe("Previous day low");
    expect(found?.strength).toBe(3);
  });
  it("reads a hammer shape after a rally as a bearish hanging man, not a bullish pin bar", () => {
    const rally = [bar(98, 101, 97, 100), bar(100, 103, 99, 102), bar(102, 105, 101, 104), bar(104, 107, 103, 106), bar(106, 109, 105, 108), bar(108, 111, 107, 110)];
    const shape = bar(110, 110.6, 105, 110.4);
    const names = detectPatterns([...rally, shape], [], 4).map((pattern) => `${pattern.name}/${pattern.bias}`);
    expect(names).toContain("Hanging man/BEARISH");
    expect(names.some((name) => name.endsWith("/BULLISH"))).toBe(false);
  });

  it("ignores a 'morning star' made of tiny noise candles or without a prior decline", () => {
    const flat = [bar(100, 100.2, 99.9, 100.1), bar(100.1, 100.2, 99.9, 100), bar(100, 100.2, 99.9, 100.1), bar(100.1, 100.2, 99.9, 100)];
    const tiny = [bar(100.1, 100.15, 99.95, 100.0), bar(100.0, 100.02, 99.98, 99.99), bar(99.99, 100.1, 99.98, 100.07)];
    expect(detectPatterns([...flat, ...tiny], [], 4).map((pattern) => pattern.name)).not.toContain("Morning star");
    const decline = [bar(112, 113, 109, 110), bar(110, 111, 107, 108), bar(108, 109, 105, 106), bar(106, 107, 103, 104)];
    const star = [bar(104, 104.5, 99.5, 100), bar(100, 100.6, 99.4, 99.8), bar(99.8, 103.6, 99.6, 103.4)];
    expect(detectPatterns([...decline, ...star], [], 4).map((pattern) => pattern.name)).toContain("Morning star");
  });

  it("does not let the overnight gap inflate intraday ATR", () => {
    const day1 = Date.parse("2026-09-29T09:15:00+05:30") / 1000;
    const day2 = Date.parse("2026-09-30T09:15:00+05:30") / 1000;
    const bars: Bar[] = [
      ...Array.from({ length: 15 }, (_, i) => ({ time: day1 + i * 300, open: 100, high: 105, low: 95, close: 100 })),
      { time: day2, open: 250, high: 255, low: 245, close: 250 }, // 150-pt gap, 10-pt range
    ];
    expect(atr(bars)).toBeCloseTo(10, 5);
  });

  it("voids a long whose live price is already below the 1m lows that define the stop", () => {
    const stack = bullishStack(1);
    for (const candle of stack["1m"].slice(-5)) { candle.open += 8; candle.high += 8; candle.low += 8; candle.close += 8; }
    const decision = run(stack, MTF_NOW, stack.spot);
    expect(decision.action).toBe("WAIT");
    expect(decision.headline).toMatch(/already through the 1m lows/);
  });

  it("detects bearish engulfing", () => {
    const patterns = detectPatterns([bar(100, 101, 99, 100.5), bar(100, 102, 99.8, 101.8), bar(102, 102.2, 98.5, 99)]);
    expect(patterns.map((pattern) => pattern.name)).toContain("Bearish engulfing");
  });
});

describe("option valuation", () => {
  it("splits intrinsic and time value", () => {
    const value = valueOption({ side: "CE", trading_symbol: "X", strike: 24800, premium: 180, delta: 0.7 }, 24900, null, null);
    expect(value.intrinsic).toBe(100);
    expect(value.extrinsic).toBe(80);
    expect(value.extrinsicPct).toBe(44);
    expect(value.verdict).toBe("UNKNOWN");
  });
  it("prices with Black-Scholes and respects put-call parity", () => {
    const years = 7 / 365;
    const call = blackScholes("CE", 25000, 25000, years, 14);
    const put = blackScholes("PE", 25000, 25000, years, 14);
    expect(call).toBeGreaterThan(150);
    expect(call - put).toBeCloseTo(25000 - 25000 * Math.exp(-0.065 * years), 0);
  });
  it("flags a premium far above fair value as overpriced", () => {
    const value = valueOption({ side: "PE", trading_symbol: "X", strike: 25000, premium: 400, delta: -0.5 }, 25000, 12, "2026-10-01", MTF_NOW);
    expect(value.verdict).toBe("OVERPRICED");
  });
});

describe("indicators", () => {
  it("computes Wilder RSI from the most recent data", () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(rising)).toBe(100);
    const falling = [...rising, ...Array.from({ length: 20 }, (_, i) => 129 - i * 2)];
    expect(rsi(falling)!).toBeLessThan(30);
  });
});
