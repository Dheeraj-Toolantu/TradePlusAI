import { describe, expect, it } from "vitest";
import { regroup, supportResistance, type SrBar } from "../../apps/web/components/backtest/sr-levels";

let t = 0;
const bar = (high: number, low: number, close = (high + low) / 2): SrBar => ({ time: (t += 3600), open: (high + low) / 2, high, low, close });

describe("support / resistance levels", () => {
  it("clusters repeated swing highs/lows into levels with touch counts and roles from the current price", () => {
    t = 0;
    // Range 100–110 tested three times on each side, price now in the middle.
    const bars: SrBar[] = [];
    for (let k = 0; k < 3; k += 1) bars.push(bar(104, 102), bar(107, 104), bar(110, 106), bar(107, 104), bar(104, 102), bar(103, 100.2), bar(104, 102));
    bars.push(bar(106, 104, 105));
    const levels = supportResistance(bars, { pivot: 2, perSide: 2 });
    const resistance = levels.find((level) => level.role === "R")!;
    const support = levels.find((level) => level.role === "S")!;
    expect(resistance.price).toBeCloseTo(110, 0);
    expect(resistance.touches).toBe(3);
    expect(support.price).toBeCloseTo(100.2, 0);
    expect(support.touches).toBe(3);
    expect(levels.every((level) => (level.role === "R" ? level.price >= 105 : level.price < 105))).toBe(true);
  });

  it("keeps the nearest levels per side, multi-touch first, and flips role with price (polarity)", () => {
    t = 0;
    const bars: SrBar[] = [];
    for (const top of [120, 120.1, 130, 140]) bars.push(bar(top - 4, top - 6), bar(top - 2, top - 4), bar(top, top - 2), bar(top - 2, top - 4), bar(top - 4, top - 6));
    // Swing highs 120 / 120.1 / 130 / 140 and swing lows 114 / 114.1 / 124 / 134.
    const all = supportResistance(bars, { pivot: 2, perSide: 10, price: 110 });
    expect(all.map((level) => [level.role, Math.round(level.price), level.touches])).toContainEqual(["R", 120, 2]);
    // Price 135: the double-top 120 (resistance before) is now SUPPORT, and it is preferred over
    // nearer single-touch levels; 140 is the resistance.
    const above = supportResistance(bars, { pivot: 2, perSide: 1, price: 135 });
    expect(above.find((level) => level.role === "S")).toMatchObject({ touches: 2 });
    expect(above.find((level) => level.role === "S")!.price).toBeCloseTo(120, 0);
    expect(above.find((level) => level.role === "R")!.price).toBeCloseTo(140, 0);
  });

  it("regroups daily candles into months", () => {
    const day = 86_400;
    const start = Date.parse("2026-01-01T00:00:00Z") / 1000;
    const daily: SrBar[] = Array.from({ length: 70 }, (_, i) => ({ time: start + i * day, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i }));
    const month = (time: number) => { const d = new Date(time * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
    const months = regroup(daily, month);
    expect(months).toHaveLength(3);
    expect(months[0]).toMatchObject({ open: 100, high: 131, low: 99, close: 130.5 });
  });

  it("does not chain a drifting series of pivots into one ever-wider level", () => {
    t = 0;
    // Swing highs stepping up by 0.3 each time: neighbours are within tolerance, the ends are not.
    const bars: SrBar[] = [];
    for (let k = 0; k < 12; k += 1) { const top = 100 + k * 0.3; bars.push(bar(top - 2, top - 3), bar(top - 1, top - 2), bar(top, top - 1), bar(top - 1, top - 2), bar(top - 2, top - 3)); }
    const levels = supportResistance(bars, { pivot: 2, perSide: 10, price: 90 });
    expect(Math.max(...levels.map((level) => level.touches))).toBeLessThan(12);
  });

  it("returns nothing without enough candles", () => {
    expect(supportResistance([bar(1, 0), bar(2, 1)], { pivot: 2 })).toEqual([]);
  });
});
