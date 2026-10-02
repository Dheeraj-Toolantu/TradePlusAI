/**
 * Support / resistance levels for one timeframe, the way a discretionary trader marks them:
 *
 *  1. Swing pivots: highs and lows that stand out from `pivot` candles on each side.
 *  2. Cluster: pivots within a tolerance (0.35 ATR of that timeframe, at least 0.05% of price) of the
 *     cluster's lowest pivot are one level (a cluster is never wider than the tolerance, so a long
 *     sideways stretch cannot chain into one huge "level"); the level's price is the cluster average
 *     and its strength is the number of touches.
 *     A level that was tested several times is where orders keep showing up.
 *  3. Role from the current price: above it a level is resistance, below it support (a broken
 *     resistance becomes support — polarity follows price).
 *  4. Keep the nearest `perSide` levels on each side, preferring multi-touch levels.
 *
 * Callers pass only COMPLETED candles of the timeframe, so nothing is drawn from the future.
 */
export type SrBar = { time: number; open: number; high: number; low: number; close: number };
export type SrLevel = { price: number; role: "S" | "R"; touches: number; lastTime: number };

function atr(bars: SrBar[], period = 14) {
  if (!bars.length) return 0;
  const recent = bars.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const bar = recent[i]; const prev = recent[i - 1];
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
  }
  return recent.length > 1 ? sum / (recent.length - 1) : recent[0].high - recent[0].low;
}

export function supportResistance(bars: SrBar[], options: { pivot: number; perSide?: number; price?: number }): SrLevel[] {
  const { pivot } = options;
  const perSide = options.perSide ?? 2;
  if (bars.length < pivot * 2 + 1) return [];
  const price = options.price ?? bars.at(-1)!.close;
  const tolerance = Math.max(0.35 * atr(bars), price * 0.0005);

  const pivots: Array<{ price: number; time: number }> = [];
  for (let i = pivot; i < bars.length - pivot; i += 1) {
    const window = bars.slice(i - pivot, i + pivot + 1);
    const c = bars[i];
    if (window.every((other) => other === c || other.high < c.high)) pivots.push({ price: c.high, time: c.time });
    if (window.every((other) => other === c || other.low > c.low)) pivots.push({ price: c.low, time: c.time });
  }

  // Greedy clustering on sorted prices.
  pivots.sort((a, b) => a.price - b.price);
  const clusters: Array<{ sum: number; count: number; lastTime: number; bottom: number }> = [];
  for (const point of pivots) {
    const current = clusters.at(-1);
    if (current && point.price - current.bottom <= tolerance) { current.sum += point.price; current.count += 1; current.lastTime = Math.max(current.lastTime, point.time); }
    else clusters.push({ sum: point.price, count: 1, lastTime: point.time, bottom: point.price });
  }
  const levels: SrLevel[] = clusters.map((cluster) => {
    const level = cluster.sum / cluster.count;
    return { price: Math.round(level * 100) / 100, role: level >= price ? "R" : "S", touches: cluster.count, lastTime: cluster.lastTime };
  });

  // Nearest per side, multi-touch levels first.
  const pick = (role: "S" | "R") => {
    const side = levels.filter((level) => level.role === role).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    const strong = side.filter((level) => level.touches >= 2);
    return [...strong, ...side.filter((level) => level.touches < 2)].slice(0, perSide);
  };
  return [...pick("R"), ...pick("S")].sort((a, b) => b.price - a.price);
}

/** Groups bars into fixed buckets (for 4H / 1H / 15m / … from finer bars, or 1M from daily bars). */
export function regroup<T extends SrBar>(bars: T[], keyOf: (time: number) => number): SrBar[] {
  const out: SrBar[] = [];
  let key = NaN;
  for (const bar of bars) {
    const k = keyOf(bar.time);
    const last = out.at(-1);
    if (last && k === key) { last.high = Math.max(last.high, bar.high); last.low = Math.min(last.low, bar.low); last.close = bar.close; }
    else { out.push({ time: k, open: bar.open, high: bar.high, low: bar.low, close: bar.close }); key = k; }
  }
  return out;
}
