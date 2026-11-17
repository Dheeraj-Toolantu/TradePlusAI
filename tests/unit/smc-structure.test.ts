import { describe, expect, it } from "vitest";
import { computeSmcStructure, forDisplay, type Bar } from "../../apps/web/lib/smc-structure";

// A candle that opens at `o` and closes at `c`, with wicks `w` beyond the body.
let t = 1_763_350_200; // 2025-11-17 09:00 IST-ish, 5-minute spacing
const bar = (o: number, c: number, w = 1, hi?: number, lo?: number): Bar => {
  t += 300;
  return { time: t, open: o, close: c, high: hi ?? Math.max(o, c) + w, low: lo ?? Math.min(o, c) - w };
};
/** Straight run of candles from `a` to `b` in `n` steps; the last candle's wick marks the turn. */
const leg = (a: number, b: number, n: number) => Array.from({ length: n }, (_, k) => {
  const candle = bar(a + ((b - a) * k) / n, a + ((b - a) * (k + 1)) / n, 0.5);
  if (k === n - 1) { if (b > a) candle.high += 0.7; else candle.low -= 0.7; }
  return candle;
});

describe("swing labels", () => {
  it("labels an uptrend zigzag HH / HL and a downtrend LH / LL", () => {
    const up = [...leg(100, 110, 4), ...leg(110, 105, 4), ...leg(105, 118, 4), ...leg(118, 111, 4), ...leg(111, 125, 4), ...leg(125, 119, 4), ...leg(119, 121, 3)];
    const s = computeSmcStructure(up);
    const labels = s.swings.map((x) => x.label);
    expect(labels).toContain("HH");
    expect(labels).toContain("HL");
    expect(labels).not.toContain("LL");
    const down = [...leg(200, 190, 4), ...leg(190, 195, 4), ...leg(195, 182, 4), ...leg(182, 189, 4), ...leg(189, 175, 4), ...leg(175, 181, 4), ...leg(181, 179, 3)];
    const d = computeSmcStructure(down).swings.map((x) => x.label);
    expect(d).toContain("LH");
    expect(d).toContain("LL");
    expect(d).not.toContain("HH");
  });

  it("confirms a swing only after `length` right-hand candles", () => {
    const bars = [...leg(100, 110, 4), ...leg(110, 104, 4)];
    const s = computeSmcStructure(bars, { length: 2 });
    for (const swing of s.swings) expect(swing.confirmedIndex).toBe(swing.index + 2);
  });
});

describe("structure breaks", () => {
  const uptrend = () => [...leg(100, 110, 4), ...leg(110, 105, 4), ...leg(105, 118, 4), ...leg(118, 111, 4), ...leg(111, 125, 4), ...leg(125, 119, 4)];

  it("marks BOS with the trend, then a CHoCH against it", () => {
    const bars = [...uptrend(), ...leg(119, 113, 3), ...leg(113, 109, 3)];
    const s = computeSmcStructure(bars);
    const kinds = s.events.map((e) => `${e.kind}:${e.dir}`);
    expect(kinds).toContain("BOS:bull");
    const flip = s.events.find((e) => e.dir === "bear");
    expect(flip?.kind === "CHoCH" || flip?.kind === "MSS").toBe(true);
  });

  it("calls it MSS only when the protected swing breaks on displacement", () => {
    const base = uptrend();
    // a slow bleed through the protected low: CHoCH, not MSS
    const slow = computeSmcStructure([...base, ...leg(119, 112, 6), ...leg(112, 108, 6)]).events.filter((e) => e.dir === "bear");
    expect(slow.some((e) => e.kind === "MSS")).toBe(false);
    // one large bearish displacement candle straight through the protected low
    const fast = computeSmcStructure([...base, bar(119, 118.5, 0.3), bar(118.5, 118.8, 0.3), bar(118.8, 96, 0.2)]).events.filter((e) => e.dir === "bear");
    expect(fast.at(-1)).toMatchObject({ kind: "MSS", displacement: true, protectedBreak: true });
  });

  it("records the first pullback low after a bullish BOS as inducement and marks it taken", () => {
    const bars = [...uptrend(), ...leg(119, 122, 3), ...leg(122, 117, 4)];
    const s = computeSmcStructure(bars);
    expect(s.inducements.length).toBeGreaterThan(0);
    const idm = s.inducements[0];
    expect(idm.dir).toBe("bull");
    const bos = s.events.find((e) => e.kind === "BOS" && e.dir === "bull")!;
    expect(idm.index).toBeGreaterThan(bos.index);
  });
});

describe("liquidity sweep vs grab vs breakout", () => {
  // swing high at 110 (BSL), then a pullback
  const setup = () => [...leg(100, 110, 4), ...leg(110, 104, 4)];

  it("a wick through that closes back is a SWEEP", () => {
    const s = computeSmcStructure([...setup(), ...leg(104, 108, 2), bar(108, 107, 0, 113, 106)]);
    expect(s.liquidityEvents.at(-1)).toMatchObject({ kind: "SWEEP", side: "BSL" });
  });

  it("a close through that is reclaimed within 3 candles is a GRAB", () => {
    const s = computeSmcStructure([...setup(), ...leg(104, 108, 2), bar(108, 112, 0.5), bar(112, 111, 0.5), bar(111, 106, 0.5)]);
    const grab = s.liquidityEvents.find((e) => e.kind === "GRAB");
    expect(grab).toMatchObject({ side: "BSL", price: 111.2 });
    expect(grab!.reclaimIndex).toBeGreaterThan(grab!.index);
  });

  it("a close through that holds is a breakout: no sweep and no grab", () => {
    const s = computeSmcStructure([...setup(), ...leg(104, 108, 2), bar(108, 113, 0.5), ...leg(113, 118, 4)]);
    expect(s.liquidityEvents).toHaveLength(0);
    expect(s.liquidity.find((l) => l.side === "BSL" && l.outcome === "BROKEN")).toBeTruthy();
  });
});

describe("no look-ahead", () => {
  it("everything known at candle k is identical with or without the candles after k", () => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    t = 1_763_350_200;
    const bars: Bar[] = [];
    let price = 24000;
    for (let i = 0; i < 400; i += 1) {
      const o = price; const c = o + (rand() - 0.5) * 30; price = c;
      bars.push({ time: (t += 300), open: o, close: c, high: Math.max(o, c) + rand() * 8, low: Math.min(o, c) - rand() * 8 });
    }
    const full = computeSmcStructure(bars);
    for (const k of [60, 150, 275, 399]) {
      const part = computeSmcStructure(bars.slice(0, k + 1));
      expect(part.swings).toEqual(full.swings.filter((s) => s.confirmedIndex <= k));
      expect(part.events).toEqual(full.events.filter((e) => e.index <= k));
      expect(part.liquidityEvents).toEqual(full.liquidityEvents.filter((e) => e.reclaimIndex <= k));
      expect(part.inducements.map((x) => x.index)).toEqual(full.inducements.filter((x) => x.confirmedIndex <= k).map((x) => x.index));
    }
    expect(full.events.length).toBeGreaterThan(5);
    const shown = forDisplay(full, bars);
    expect(shown.events.length).toBeLessThanOrEqual(10);
  });
});

describe("dealing range and merged liquidity events", () => {
  it("gives a premium / discount read in a straight-line trend (protected swing to the extreme since)", () => {
    const down = [...leg(200, 190, 4), ...leg(190, 195, 4), ...leg(195, 182, 4), ...leg(182, 189, 4), ...leg(189, 170, 8)];
    const s = computeSmcStructure(down);
    expect(s.trend).toBe("bear");
    expect(s.premiumDiscount).not.toBeNull();
    expect(s.premiumDiscount!.high).toBe(s.protectedLevel!.price);
    expect(s.premiumDiscount!.zone).toBe("DISCOUNT");
  });

  it("one candle taking two levels is one event listing both", () => {
    // two untaken swing lows (104.3 and an equal 104.4), then one candle wicks below both and closes back above
    const bars = [...leg(100, 110, 4), ...leg(110, 105, 4), ...leg(105, 112, 4), ...leg(112, 105.1, 4), ...leg(105.1, 108, 4), bar(108, 107, 0, 109, 99)];
    const s = computeSmcStructure(bars);
    const sweeps = s.liquidityEvents.filter((e) => e.kind === "SWEEP" && e.side === "SSL");
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].levels.length).toBe(2);
    expect(sweeps[0].price).toBe(Math.min(...sweeps[0].levels));
  });
});
