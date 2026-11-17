/**
 * Market structure and smart-money concepts for one chart timeframe (browser-safe, pure).
 *
 * Everything is computed causally, candle by candle from the left. Each item keeps the index at
 * which it became KNOWN (`confirmedIndex` / `index`), so nothing is ever drawn from information a
 * trader could not have had at that candle.
 *
 * Definitions (SMC vocabulary varies between educators; these are the rules this code applies):
 *
 *  Swing           fractal pivot: a high above the highs of `length` candles on each side (low:
 *                  mirror). Confirmed when the `length`-th right-hand candle closes.
 *  HH / LH         a confirmed swing high above / below the previous swing high. Within
 *                  `equalTolerance` x ATR of it: EQH (equal highs, resting buy-side liquidity).
 *  HL / LL         a confirmed swing low above / below the previous swing low. Equal: EQL.
 *  BOS             break of structure: a candle CLOSES beyond the last unbroken swing in the
 *                  direction of the current trend (continuation).
 *  CHoCH           change of character: the first close beyond the last swing AGAINST the trend.
 *  MSS             market structure shift: a CHoCH that closes through the PROTECTED swing (the
 *                  swing the last BOS leg started from: the higher low of an uptrend, the lower high
 *                  of a downtrend) on a displacement candle (body >= 60% of its range and range
 *                  >= 1.2 ATR). A CHoCH without both stays a CHoCH (an early warning only).
 *  IDM             inducement: after a BOS, the first confirmed pullback swing in the new leg (the
 *                  first low after a bullish BOS). Early traders' stops rest there; it is marked
 *                  "taken" when a later candle trades through it.
 *  Liquidity       BSL above unswept swing highs, SSL below unswept swing lows (EQH / EQL marked).
 *  Sweep           a candle WICKS through a liquidity level by more than the tolerance and CLOSES
 *                  back on the original side: a one-candle stop run.
 *  Grab            a candle CLOSES through a liquidity level and price closes back on the original
 *                  side within `grabWindow` candles: a failed breakout / stop hunt. If it does not
 *                  come back it was a breakout, not a grab, and nothing is marked.
 *  Order block     on each BOS / CHoCH / MSS, the last opposite-colour candle between the broken
 *                  swing and the break. Mitigated when a candle trades into it, invalidated by a
 *                  close through its far side.
 *  FVG             three-candle imbalance (candle 3's low above candle 1's high, or the mirror),
 *                  at least 0.1 ATR, inside one session. Filled when price trades through its far edge.
 *  Premium/discount the current dealing range: from the protected swing to the extreme price has
 *                  reached since (the latest swing high / low pair when there is no trend yet);
 *                  above its 50% equilibrium is premium, below is discount.
 */

export type Bar = { time: number; open: number; high: number; low: number; close: number };
export type Dir = "bull" | "bear";
export type SwingLabel = "HH" | "LH" | "HL" | "LL" | "EQH" | "EQL" | "H" | "L";
export type Swing = { kind: "HIGH" | "LOW"; index: number; confirmedIndex: number; price: number; label: SwingLabel };
export type StructureEvent = { kind: "BOS" | "CHoCH" | "MSS"; dir: Dir; fromIndex: number; index: number; price: number; displacement: boolean; protectedBreak: boolean };
export type Inducement = { dir: Dir; index: number; confirmedIndex: number; price: number; takenIndex: number | null };
export type LiquidityLevel = { side: "BSL" | "SSL"; equal: boolean; fromIndex: number; price: number; endIndex: number | null; outcome: "OPEN" | "SWEPT" | "GRABBED" | "BROKEN" };
/** One event per candle and side: `levels` lists every liquidity level that candle took (price = the outermost). */
export type LiquidityEvent = { kind: "SWEEP" | "GRAB"; side: "BSL" | "SSL"; index: number; levelIndex: number; price: number; levels: number[]; extreme: number; reclaimIndex: number };
export type Zone = { kind: "OB" | "FVG"; dir: Dir; fromIndex: number; top: number; bottom: number; endIndex: number | null; state: "ACTIVE" | "MITIGATED" | "INVALIDATED" | "FILLED" };
export type PremiumDiscount = { high: number; low: number; equilibrium: number; fromIndex: number; zone: "PREMIUM" | "DISCOUNT" | "EQUILIBRIUM" };
export type SmcStructure = {
  swings: Swing[];
  events: StructureEvent[];
  inducements: Inducement[];
  liquidity: LiquidityLevel[];
  liquidityEvents: LiquidityEvent[];
  orderBlocks: Zone[];
  fvgs: Zone[];
  premiumDiscount: PremiumDiscount | null;
  trend: Dir | null;
  protectedLevel: { price: number; index: number; dir: Dir } | null;
  atr: number;
};
export type SmcOptions = { length?: number; equalTolerance?: number; grabWindow?: number; displacementBody?: number; displacementAtr?: number; sessionOffsetSeconds?: number };

function atrSeries(bars: Bar[], period = 14) {
  const out: number[] = [];
  let value = 0;
  bars.forEach((bar, i) => {
    const prev = bars[i - 1];
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    value = i === 0 ? tr : i < period ? (value * i + tr) / (i + 1) : (value * (period - 1) + tr) / period;
    out.push(value);
  });
  return out;
}

export function computeSmcStructure(bars: Bar[], options: SmcOptions = {}): SmcStructure {
  const length = Math.max(1, Math.floor(options.length ?? 2));
  const eqTol = options.equalTolerance ?? 0.1;
  const grabWindow = Math.max(1, options.grabWindow ?? 3);
  const dispBody = options.displacementBody ?? 0.6;
  const dispAtr = options.displacementAtr ?? 1.2;
  const offset = options.sessionOffsetSeconds ?? 330 * 60; // IST sessions for the FVG rule
  const sessionOf = (t: number) => Math.floor((t + offset) / 86_400);
  const atr = atrSeries(bars);

  const swings: Swing[] = [];
  const events: StructureEvent[] = [];
  const inducements: Inducement[] = [];
  const liquidity: LiquidityLevel[] = [];
  const liquidityEvents: LiquidityEvent[] = [];
  const orderBlocks: Zone[] = [];
  const fvgs: Zone[] = [];
  let trend: Dir | null = null;
  let lastHigh: Swing | null = null; // last confirmed swing high
  let lastLow: Swing | null = null;
  let breakHigh: { swing: Swing; broken: boolean } | null = null; // structure targets
  let breakLow: { swing: Swing; broken: boolean } | null = null;
  let protectedSwing: Swing | null = null;
  let awaitingIdm: { dir: Dir; afterIndex: number } | null = null;
  // Levels closed through and waiting to see if price comes back (grab) or not (breakout).
  const pendingGrabs: Array<{ level: LiquidityLevel; index: number; extreme: number }> = [];
  const addLiquidityEvent = (event: Omit<LiquidityEvent, "levels">) => {
    const same = liquidityEvents.find((e) => e.kind === event.kind && e.side === event.side && e.index === event.index && e.reclaimIndex === event.reclaimIndex);
    if (!same) { liquidityEvents.push({ ...event, levels: [event.price] }); return; }
    same.levels.push(event.price);
    const outer = event.side === "BSL" ? Math.max(...same.levels) : Math.min(...same.levels);
    if (outer === event.price) { same.price = event.price; same.levelIndex = event.levelIndex; }
    same.extreme = event.side === "BSL" ? Math.max(same.extreme, event.extreme) : Math.min(same.extreme, event.extreme);
  };

  const isDisplacement = (i: number, dir: Dir) => {
    const b = bars[i];
    const range = b.high - b.low;
    const body = (b.close - b.open) * (dir === "bull" ? 1 : -1);
    return range > 0 && body > 0 && body / range >= dispBody && range >= dispAtr * (atr[i - 1] ?? atr[i]);
  };

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const tol = eqTol * (atr[i] || 0);

    // ---- zones: mitigation / invalidation / fill by this candle
    for (const z of orderBlocks) {
      if (z.state === "INVALIDATED") continue;
      if (z.dir === "bull" ? bar.close < z.bottom : bar.close > z.top) { z.state = "INVALIDATED"; z.endIndex = i; continue; }
      if (z.state === "ACTIVE" && z.fromIndex < i - 1 && (z.dir === "bull" ? bar.low <= z.top : bar.high >= z.bottom)) z.state = "MITIGATED";
    }
    for (const z of fvgs) if (z.state === "ACTIVE" && (z.dir === "bull" ? bar.low <= z.bottom : bar.high >= z.top)) { z.state = "FILLED"; z.endIndex = i; }

    // ---- liquidity: grabs resolving, then sweeps / closes through open levels
    for (let k = pendingGrabs.length - 1; k >= 0; k -= 1) {
      const p = pendingGrabs[k];
      const bsl = p.level.side === "BSL";
      p.extreme = bsl ? Math.max(p.extreme, bar.high) : Math.min(p.extreme, bar.low);
      if (bsl ? bar.close < p.level.price : bar.close > p.level.price) {
        p.level.outcome = "GRABBED"; p.level.endIndex = i;
        addLiquidityEvent({ kind: "GRAB", side: p.level.side, index: p.index, levelIndex: p.level.fromIndex, price: p.level.price, extreme: p.extreme, reclaimIndex: i });
        pendingGrabs.splice(k, 1);
      } else if (i - p.index >= grabWindow) {
        p.level.outcome = "BROKEN"; p.level.endIndex = p.index;
        pendingGrabs.splice(k, 1);
      }
    }
    for (const level of liquidity) {
      if (level.outcome !== "OPEN" || level.fromIndex >= i - length || pendingGrabs.some((p) => p.level === level)) continue;
      const bsl = level.side === "BSL";
      const through = bsl ? bar.high > level.price + tol : bar.low < level.price - tol;
      if (!through) continue;
      const closedBack = bsl ? bar.close < level.price : bar.close > level.price;
      if (closedBack) {
        level.outcome = "SWEPT"; level.endIndex = i;
        addLiquidityEvent({ kind: "SWEEP", side: level.side, index: i, levelIndex: level.fromIndex, price: level.price, extreme: bsl ? bar.high : bar.low, reclaimIndex: i });
      } else {
        pendingGrabs.push({ level, index: i, extreme: bsl ? bar.high : bar.low });
      }
    }

    // ---- inducement taken
    for (const idm of inducements) {
      if (idm.takenIndex === null && idm.confirmedIndex < i && (idm.dir === "bull" ? bar.low < idm.price : bar.high > idm.price)) idm.takenIndex = i;
    }

    // ---- structure breaks on a close (targets are swings confirmed before this candle)
    const breakOf = (target: { swing: Swing; broken: boolean }, dir: Dir) => {
      target.broken = true;
      const against = trend !== null && trend !== dir;
      // The candle CLOSES through the protected swing (it may break a newer internal swing first).
      const guard = protectedSwing as Swing | null;
      const protectedBreak = against && guard !== null && (dir === "bull" ? bar.close > guard.price : bar.close < guard.price);
      const displacement = isDisplacement(i, dir);
      const kind: StructureEvent["kind"] = !against ? "BOS" : protectedBreak && displacement ? "MSS" : "CHoCH";
      events.push({ kind, dir, fromIndex: target.swing.index, index: i, price: target.swing.price, displacement, protectedBreak });
      trend = dir;
      // The leg's origin becomes the protected swing: the last swing low before a bullish break.
      protectedSwing = dir === "bull" ? lastLow : lastHigh;
      awaitingIdm = { dir, afterIndex: i };
      for (let k = i - 1; k >= target.swing.index; k -= 1) {
        const c = bars[k];
        if (dir === "bull" ? c.close < c.open : c.close > c.open) { orderBlocks.push({ kind: "OB", dir, fromIndex: k, top: c.high, bottom: c.low, endIndex: null, state: "ACTIVE" }); break; }
      }
    };
    if (breakHigh && !breakHigh.broken && bar.close > breakHigh.swing.price) breakOf(breakHigh, "bull");
    if (breakLow && !breakLow.broken && bar.close < breakLow.swing.price) breakOf(breakLow, "bear");

    // ---- FVG completed by this candle
    if (i >= 2 && sessionOf(bars[i - 2].time) === sessionOf(bar.time)) {
      const a = bars[i - 2];
      const min = 0.1 * (atr[i] || 0);
      if (bar.low - a.high > min) fvgs.push({ kind: "FVG", dir: "bull", fromIndex: i - 1, top: bar.low, bottom: a.high, endIndex: null, state: "ACTIVE" });
      if (a.low - bar.high > min) fvgs.push({ kind: "FVG", dir: "bear", fromIndex: i - 1, top: a.low, bottom: bar.high, endIndex: null, state: "ACTIVE" });
    }

    // ---- confirm the pivot `length` candles back (known from this candle's close onward)
    const p = i - length;
    if (p >= length) {
      const c = bars[p];
      const window = bars.slice(p - length, p + length + 1);
      const ptol = eqTol * (atr[p] || 0);
      if (window.every((o) => o === c || o.high < c.high)) {
        const label: SwingLabel = !lastHigh ? "H" : Math.abs(c.high - lastHigh.price) <= ptol ? "EQH" : c.high > lastHigh.price ? "HH" : "LH";
        const swing: Swing = { kind: "HIGH", index: p, confirmedIndex: i, price: c.high, label };
        swings.push(swing); lastHigh = swing; breakHigh = { swing, broken: false };
        const twin = liquidity.find((l) => l.outcome === "OPEN" && l.side === "BSL" && Math.abs(l.price - c.high) <= ptol);
        if (twin) twin.equal = true;
        liquidity.push({ side: "BSL", equal: Boolean(twin), fromIndex: p, price: c.high, endIndex: null, outcome: "OPEN" });
        if (awaitingIdm && awaitingIdm.dir === "bear" && p > awaitingIdm.afterIndex) { inducements.push({ dir: "bear", index: p, confirmedIndex: i, price: c.high, takenIndex: null }); awaitingIdm = null; }
      }
      if (window.every((o) => o === c || o.low > c.low)) {
        const label: SwingLabel = !lastLow ? "L" : Math.abs(c.low - lastLow.price) <= ptol ? "EQL" : c.low > lastLow.price ? "HL" : "LL";
        const swing: Swing = { kind: "LOW", index: p, confirmedIndex: i, price: c.low, label };
        swings.push(swing); lastLow = swing; breakLow = { swing, broken: false };
        const twin = liquidity.find((l) => l.outcome === "OPEN" && l.side === "SSL" && Math.abs(l.price - c.low) <= ptol);
        if (twin) twin.equal = true;
        liquidity.push({ side: "SSL", equal: Boolean(twin), fromIndex: p, price: c.low, endIndex: null, outcome: "OPEN" });
        if (awaitingIdm && awaitingIdm.dir === "bull" && p > awaitingIdm.afterIndex) { inducements.push({ dir: "bull", index: p, confirmedIndex: i, price: c.low, takenIndex: null }); awaitingIdm = null; }
      }
    }
  }

  const last = bars.at(-1);
  const ps = protectedSwing as Swing | null;
  // Dealing range: protected swing -> the extreme reached since (in a trend), else the last swing pair.
  let range: { high: number; low: number; fromIndex: number } | null = null;
  if (ps && trend) {
    const since = bars.slice(ps.index);
    range = trend === "bull" ? { low: ps.price, high: Math.max(...since.map((b) => b.high)), fromIndex: ps.index } : { high: ps.price, low: Math.min(...since.map((b) => b.low)), fromIndex: ps.index };
  } else if (lastHigh && lastLow) {
    const hs = lastHigh as Swing; const ls = lastLow as Swing;
    range = { high: Math.max(hs.price, ls.price), low: Math.min(hs.price, ls.price), fromIndex: Math.min(hs.index, ls.index) };
  }
  let premiumDiscount: PremiumDiscount | null = null;
  if (last && range && range.high > range.low) {
    const eq = (range.high + range.low) / 2;
    const band = (range.high - range.low) * 0.05;
    premiumDiscount = { ...range, equilibrium: eq, zone: last.close > eq + band ? "PREMIUM" : last.close < eq - band ? "DISCOUNT" : "EQUILIBRIUM" };
  }
  return {
    swings, events, inducements, liquidity, liquidityEvents, orderBlocks, fvgs, premiumDiscount, trend,
    protectedLevel: ps && trend ? { price: ps.price, index: ps.index, dir: trend } : null,
    atr: atr.at(-1) ?? 0,
  };
}

/** Keep the chart readable: the most recent events and the active zones / open levels near price. */
export function forDisplay(s: SmcStructure, bars: Bar[], limits = { events: 10, swings: 28, zones: 2, levels: 2, liquidityEvents: 6, recent: 15 }): SmcStructure {
  const lastIndex = bars.length - 1;
  const price = bars.at(-1)?.close ?? 0;
  const near = <T,>(items: T[], level: (item: T) => number, n: number) => [...items].sort((a, b) => Math.abs(level(a) - price) - Math.abs(level(b) - price)).slice(0, n);
  const zones = (items: Zone[]) => {
    const active = (dir: Dir) => near(items.filter((z) => z.dir === dir && (z.state === "ACTIVE" || z.state === "MITIGATED")), (z) => (z.top + z.bottom) / 2, limits.zones);
    const recent = items.filter((z) => z.endIndex !== null && z.endIndex >= lastIndex - limits.recent);
    return [...active("bull"), ...active("bear"), ...recent].sort((a, b) => a.fromIndex - b.fromIndex);
  };
  const open = (side: "BSL" | "SSL") => near(s.liquidity.filter((l) => l.side === side && l.outcome === "OPEN"), (l) => l.price, limits.levels);
  return {
    ...s,
    swings: s.swings.slice(-limits.swings),
    events: s.events.slice(-limits.events),
    inducements: s.inducements.slice(-3),
    liquidity: [...open("BSL"), ...open("SSL"), ...s.liquidity.filter((l) => l.outcome !== "OPEN" && l.outcome !== "BROKEN" && (l.endIndex ?? 0) >= lastIndex - limits.recent)],
    liquidityEvents: s.liquidityEvents.slice(-limits.liquidityEvents),
    orderBlocks: zones(s.orderBlocks),
    fvgs: zones(s.fvgs),
  };
}
