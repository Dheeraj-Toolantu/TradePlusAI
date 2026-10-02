import { describe, expect, it } from "vitest";
import { computeSmcOverlays, type OverlayBar } from "../../apps/web/components/backtest/smc-overlays";

let clock = 0;
const bar = (open: number, high: number, low: number, close: number): OverlayBar => ({ time: (clock += 300), open, high, low, close });
/** A quiet candle around a price. */
const flat = (price: number) => bar(price, price + 1, price - 1, price);

describe("SMC chart overlays", () => {
  it("draws a bullish FVG from the 3-candle imbalance and closes it when price fills the gap", () => {
    clock = 0;
    const bars = [flat(100), flat(100), flat(100), bar(100, 101, 99, 100.5), bar(100.5, 108, 100.4, 107.5), bar(107.5, 110, 104, 109), flat(109), flat(108)];
    const open = computeSmcOverlays(bars).fvgs.find((zone) => zone.dir === "bull")!;
    expect(open).toMatchObject({ kind: "FVG", bottom: 101, top: 104, fromIndex: 4, active: true, toIndex: bars.length - 1 });
    const filled = computeSmcOverlays([...bars, bar(108, 108.5, 100.8, 101.5)]).fvgs.find((zone) => zone.dir === "bull")!;
    expect(filled).toMatchObject({ active: false, toIndex: bars.length });
  });

  it("marks a BOS on the first break and a CHoCH when the trend flips, each with its order block", () => {
    clock = 0;
    const bars = [
      flat(100), flat(101), bar(101, 105, 100.5, 104), flat(102), flat(101.5), // swing high 105 at index 2 (confirmed at 4)
      bar(101.5, 102, 99.5, 100), // last bearish candle before the break → bullish OB
      bar(100, 107, 99.8, 106.5), // close above 105: bullish BOS
      flat(106), flat(105), bar(105, 105.5, 102, 102.5), flat(104), flat(104.5), // swing low 102 at index 9 (confirmed at 11)
      bar(104.5, 106, 104, 105.8), // last bullish candle before the break → bearish OB
      bar(105.8, 106, 100, 100.5), // close below 102: CHoCH bearish
    ];
    const { structure, orderBlocks } = computeSmcOverlays(bars);
    expect(structure.map((item) => [item.kind, item.dir, item.price, item.fromIndex, item.toIndex])).toEqual([["BOS", "bull", 105, 2, 6], ["CHoCH", "bear", 102, 9, 13]]);
    expect(orderBlocks.map((zone) => [zone.dir, zone.fromIndex, zone.bottom, zone.top])).toEqual([["bull", 5, 99.5, 102], ["bear", 12, 104, 106]]);
  });

  it("tracks liquidity: equal highs are EQH, and a wick through the level ends the line as swept", () => {
    clock = 0;
    const bars = [flat(100), flat(100), bar(100, 105, 99.5, 101), flat(100), flat(100), flat(100), bar(100, 105.05, 99.5, 101), flat(100), flat(100)];
    const before = computeSmcOverlays(bars).liquidity.filter((line) => line.dir === "BSL");
    expect(before.map((line) => [line.price, line.equal, line.swept])).toEqual([[105, true, false], [105.05, true, false]]);
    const swept = computeSmcOverlays([...bars, bar(100, 106, 99.8, 100.5)]).liquidity.filter((line) => line.dir === "BSL");
    expect(swept.every((line) => line.swept && line.toIndex === bars.length)).toBe(true);
  });

  it("ignores overnight gaps as FVGs and keeps only the nearest active zones plus recently mitigated ones", () => {
    clock = 0;
    const day = 86_400;
    const yesterday = [flat(100), flat(100), flat(100)];
    const gapOpen = { time: yesterday[2].time + day, open: 110, high: 111, low: 109, close: 110 };
    const today = [gapOpen, { ...flat(110), time: gapOpen.time + 300 }, { ...flat(110), time: gapOpen.time + 600 }];
    expect(computeSmcOverlays([...yesterday, ...today]).fvgs).toEqual([]);

    // Ten bullish gaps stacked upward: only the 4 nearest to price stay drawn by default.
    clock = 0;
    const ladder: OverlayBar[] = [flat(100), flat(100)];
    for (let k = 0; k < 10; k += 1) { const base = 100 + k * 10; ladder.push(bar(base, base + 9, base, base + 9), bar(base + 9, base + 12, base + 6, base + 11), flat(base + 10)); }
    const all = computeSmcOverlays(ladder, { fvgs: 1000, recentBars: 100_000 }).fvgs.filter((zone) => zone.active);
    const shown = computeSmcOverlays(ladder).fvgs;
    expect(all.length).toBeGreaterThan(4);
    expect(shown.filter((zone) => zone.active && zone.dir === "bull")).toHaveLength(4);
    const price = ladder.at(-1)!.close;
    const nearest = [...all].sort((a, b) => Math.abs((a.top + a.bottom) / 2 - price) - Math.abs((b.top + b.bottom) / 2 - price)).slice(0, 4).map((zone) => zone.fromIndex).sort((a, b) => a - b);
    expect(shown.filter((zone) => zone.active).map((zone) => zone.fromIndex)).toEqual(nearest);
  });

  it("is causal: what is drawn on a prefix is drawn identically once more candles arrive", () => {
    clock = 0;
    const bars: OverlayBar[] = [];
    let price = 25_000;
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 400; i += 1) { const drift = (random() - 0.5) * 14 + Math.sin(i / 40) * 3; const open = price; price += drift; bars.push(bar(open, Math.max(open, price) + random() * 3, Math.min(open, price) - random() * 3, price)); }
    const all = computeSmcOverlays(bars, { obs: 1000, fvgs: 1000, lines: 1000, breaks: 1000, recentBars: 100_000 });
    const prefix = computeSmcOverlays(bars.slice(0, 250), { obs: 1000, fvgs: 1000, lines: 1000, breaks: 1000, recentBars: 100_000 });
    const key = (item: { fromIndex: number }) => JSON.stringify(item);
    // Structure breaks found on the prefix are exactly the full run's breaks up to index 249.
    expect(prefix.structure.map(key)).toEqual(all.structure.filter((item) => item.toIndex < 250).map(key));
    expect(prefix.fvgs.map((zone) => [zone.fromIndex, zone.top, zone.bottom])).toEqual(all.fvgs.filter((zone) => zone.fromIndex < 249).map((zone) => [zone.fromIndex, zone.top, zone.bottom]));
    expect(all.structure.length).toBeGreaterThan(2);
  });
});
