/**
 * Smart-money-concept overlays computed from the candles on the chart (any timeframe).
 *
 * Every element is derived causally, left to right, so on a replay it only "knows" the candles
 * printed so far, exactly like a live chart:
 *
 * - Swings: 2-left / 2-right fractals, confirmed two candles after the pivot.
 * - Structure: a close beyond the last unbroken swing high (low) is a BREAK OF STRUCTURE in the
 *   current trend's direction, or a CHANGE OF CHARACTER when it flips the trend.
 * - Order block: on each break, the last opposite-colour candle between the broken swing and the
 *   break (where the move started). It stays active until a close through its far side.
 * - Fair value gap: a 3-candle imbalance (candle 3's low above candle 1's high, or the mirror),
 *   at least 0.1 ATR wide, inside one session (an overnight gap is not an intraday imbalance). It
 *   stays open until price trades back through its far edge.
 * - Liquidity: unswept swing highs (buy-side, BSL) and lows (sell-side, SSL) where stops rest; equal
 *   highs/lows within 0.1 ATR are marked EQH/EQL. A wick more than that tolerance through the level
 *   ends the line at the sweep (a tick above an equal high is still "equal", not a sweep).
 */

export type OverlayBar = { time: number; open: number; high: number; low: number; close: number };
export type Direction = "bull" | "bear";

export type Zone = { kind: "FVG" | "OB"; dir: Direction; fromIndex: number; toIndex: number; top: number; bottom: number; active: boolean };
export type LiquidityLine = { dir: "BSL" | "SSL"; equal: boolean; fromIndex: number; toIndex: number; price: number; swept: boolean; tolerance: number };
export type StructureBreak = { kind: "BOS" | "CHoCH"; dir: Direction; fromIndex: number; toIndex: number; price: number };
export type SmcOverlays = { fvgs: Zone[]; orderBlocks: Zone[]; liquidity: LiquidityLine[]; structure: StructureBreak[] };

const PIVOT = 2;

function atrSeries(bars: OverlayBar[], period = 14) {
  const out: number[] = [];
  let value = 0;
  bars.forEach((bar, index) => {
    const prev = bars[index - 1];
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    value = index === 0 ? tr : index < period ? (value * index + tr) / (index + 1) : (value * (period - 1) + tr) / period;
    out.push(value);
  });
  return out;
}

const IST_S = 330 * 60;
const sessionOf = (epochS: number) => Math.floor((epochS + IST_S) / 86_400);

/**
 * `limits` keep the chart readable the way professional SMC tools do: per side, only the most
 * relevant ACTIVE zones/levels (nearest to the current price), and mitigated / swept ones only for
 * `recentBars` candles after they were taken out.
 */
export function computeSmcOverlays(bars: OverlayBar[], limits: { obs?: number; fvgs?: number; lines?: number; breaks?: number; recentBars?: number } = {}): SmcOverlays {
  const maxObs = limits.obs ?? 3;
  const maxFvgs = limits.fvgs ?? 4;
  const maxLines = limits.lines ?? 3;
  const maxBreaks = limits.breaks ?? 10;
  const recentBars = limits.recentBars ?? 20;
  const last = bars.length - 1;
  const atr = atrSeries(bars);
  const fvgs: Zone[] = [];
  const orderBlocks: Zone[] = [];
  const liquidity: LiquidityLine[] = [];
  const structure: StructureBreak[] = [];
  let swingHigh: { index: number; price: number; broken: boolean } | null = null;
  let swingLow: { index: number; price: number; broken: boolean } | null = null;
  let trend: Direction | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];

    // Close out zones and lines that this candle mitigates or sweeps.
    for (const zone of fvgs) if (zone.active && (zone.dir === "bull" ? bar.low <= zone.bottom : bar.high >= zone.top)) { zone.active = false; zone.toIndex = i; }
    for (const zone of orderBlocks) if (zone.active && (zone.dir === "bull" ? bar.close < zone.bottom : bar.close > zone.top)) { zone.active = false; zone.toIndex = i; }
    for (const line of liquidity) if (!line.swept && (line.dir === "BSL" ? bar.high > line.price + line.tolerance : bar.low < line.price - line.tolerance)) { line.swept = true; line.toIndex = i; }

    // Confirm the pivot two candles back.
    const p = i - PIVOT;
    if (p >= PIVOT) {
      const c = bars[p];
      const window = bars.slice(p - PIVOT, p + PIVOT + 1);
      const tolerance = 0.1 * atr[p];
      if (window.every((other) => other === c || other.high < c.high)) {
        swingHigh = { index: p, price: c.high, broken: false };
        const twin = liquidity.find((line) => !line.swept && line.dir === "BSL" && Math.abs(line.price - c.high) <= tolerance);
        if (twin) twin.equal = true;
        liquidity.push({ dir: "BSL", equal: Boolean(twin), fromIndex: p, toIndex: last, price: c.high, swept: false, tolerance });
      }
      if (window.every((other) => other === c || other.low > c.low)) {
        swingLow = { index: p, price: c.low, broken: false };
        const twin = liquidity.find((line) => !line.swept && line.dir === "SSL" && Math.abs(line.price - c.low) <= tolerance);
        if (twin) twin.equal = true;
        liquidity.push({ dir: "SSL", equal: Boolean(twin), fromIndex: p, toIndex: last, price: c.low, swept: false, tolerance });
      }
    }

    // Structure breaks on a close, with the order block that launched the move.
    const breakOf = (swing: { index: number; price: number; broken: boolean }, dir: Direction) => {
      swing.broken = true;
      structure.push({ kind: trend === null || trend === dir ? "BOS" : "CHoCH", dir, fromIndex: swing.index, toIndex: i, price: swing.price });
      trend = dir;
      for (let k = i - 1; k >= swing.index; k -= 1) {
        const candle = bars[k];
        if (dir === "bull" ? candle.close < candle.open : candle.close > candle.open) {
          orderBlocks.push({ kind: "OB", dir, fromIndex: k, toIndex: last, top: candle.high, bottom: candle.low, active: true });
          break;
        }
      }
    };
    if (swingHigh && !swingHigh.broken && bar.close > swingHigh.price) breakOf(swingHigh, "bull");
    if (swingLow && !swingLow.broken && bar.close < swingLow.price) breakOf(swingLow, "bear");

    // Fair value gap completed by this candle.
    if (i >= 2 && sessionOf(bars[i - 2].time) === sessionOf(bar.time)) {
      const a = bars[i - 2];
      const minSize = 0.1 * atr[i];
      if (bar.low - a.high > minSize) fvgs.push({ kind: "FVG", dir: "bull", fromIndex: i - 1, toIndex: last, top: bar.low, bottom: a.high, active: true });
      if (a.low - bar.high > minSize) fvgs.push({ kind: "FVG", dir: "bear", fromIndex: i - 1, toIndex: last, top: a.low, bottom: bar.high, active: true });
    }
  }

  // Readability: per side, the active items nearest to the current price, plus items taken out in
  // the last `recentBars` candles.
  const price = bars.at(-1)?.close ?? 0;
  const pick = <T extends { fromIndex: number; toIndex: number }>(items: T[], open: (item: T) => boolean, side: (item: T) => string, level: (item: T) => number, max: number) => {
    const kept: T[] = [];
    for (const key of new Set(items.map(side))) {
      kept.push(...items.filter((item) => side(item) === key && open(item)).sort((a, b) => Math.abs(level(a) - price) - Math.abs(level(b) - price)).slice(0, max));
    }
    kept.push(...items.filter((item) => !open(item) && item.toIndex >= last - recentBars));
    return kept.sort((a, b) => a.fromIndex - b.fromIndex);
  };
  const mid = (zone: Zone) => (zone.top + zone.bottom) / 2;
  return {
    fvgs: pick(fvgs, (zone) => zone.active, (zone) => zone.dir, mid, maxFvgs),
    orderBlocks: pick(orderBlocks, (zone) => zone.active, (zone) => zone.dir, mid, maxObs),
    liquidity: pick(liquidity, (line) => !line.swept, (line) => line.dir, (line) => line.price, maxLines),
    structure: structure.slice(-maxBreaks),
  };
}
