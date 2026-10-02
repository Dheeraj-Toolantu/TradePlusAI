import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { aggregate, istDay, istMinute, type Signal } from "./strategy-backtest";

/**
 * SMC liquidity-sweep strategy ("sweep → shift → retrace").
 *
 * The idea a discretionary index trader would trade, written as rules:
 *  1. Map liquidity and support/resistance: previous-day high/low (PDH/PDL), the 09:15–09:30 opening
 *     range, unswept 5-minute swing highs/lows, and equal highs/lows (resting stops cluster there).
 *  2. Wait for a LIQUIDITY SWEEP: a 5m candle trades through a level and closes back inside it.
 *     Stops above/below the level have been taken; if smart money was absorbing, price should reverse.
 *  3. Demand proof: a CHANGE OF CHARACTER (CHoCH) within six 5m bars — a displacement candle (big
 *     body, closes on its extreme) that closes through the last internal swing in the new direction.
 *  4. Entry zone: the FAIR VALUE GAP left by the displacement (3-candle imbalance), else the ORDER
 *     BLOCK (last opposite candle before the move). Wait for price to RETRACE into it.
 *  5. Trigger on 1m candle psychology inside the zone: rejection wick (hammer / shooting star),
 *     engulfing, a close back out of the zone, or a strong directional close off the zone. No retrace within an hour = no trade (never chase).
 *  6. Stop beyond the sweep extreme (the level that must hold for the idea to be right). T1 at 1.5R
 *     (or the nearest opposing liquidity if closer, min 1R), T2 at the next opposing liquidity pool.
 *     Skip when opposing S/R sits closer than 1R or the stop is wider than 2.5 ATR (5m).
 *  7. Context score: 15m structure bias (BOS), premium/discount of the 15m dealing range, VWAP side,
 *     daily-level sweeps, FVG/OB overlap, displacement strength. Counter-trend setups are only taken
 *     off a daily level.
 *  8. Trader psychology / session behaviour:
 *     - Timing: the 09:30–11:30 window carries the day's real liquidity (+); 11:45–13:15 is lunch chop
 *       where sweeps fail more often (−); no new entries after 14:30 (no time left for T2).
 *     - Exhaustion: once the day's range exceeds ~1.2× the average daily range (ADR), chasing the trend
 *       is a late-entry trap (−), while a reversal off a daily extreme is the crowd being trapped (+).
 *     - Conviction: a CHoCH within two candles of the sweep (fast, violent rejection) scores higher than
 *       a slow drift back.
 *
 * Every decision uses only candles completed at decision time; 5m/15m bars are processed only after
 * they close.
 */

type Pool = { price: number; time: number; kind: "PDH" | "PDL" | "ORH" | "ORL" | "SWING" | "EQUAL"; side: 1 | -1; swept: boolean };
type Setup = {
  dir: 1 | -1; // 1 = long (after sell-side sweep), -1 = short
  stage: "SWEPT" | "WAIT_ZONE" | "ARMED";
  pool: Pool;
  sweepIndex: number;
  sweepExtreme: number;
  sweepWick: number;
  breakLevel: number;
  zone?: { lo: number; hi: number; kind: "FVG" | "OB" | "FVG+OB" };
  displacement?: number;
  /** 5m bars from the sweep to the CHoCH candle (1 = the very next candle). */
  chochBars?: number;
  barsLeft: number;
  armedAt?: number;
  expiresAt?: number;
};

const SMC_NAME = "SMC liquidity sweep";
const PIVOT = 2;

function wilder(prev: number | null, value: number, period: number) { return prev === null ? value : (prev * (period - 1) + value) / period; }
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
const KIND_LABEL: Record<Pool["kind"], string> = { PDH: "previous-day high", PDL: "previous-day low", ORH: "opening-range high", ORL: "opening-range low", SWING: "5m swing", EQUAL: "equal highs/lows" };

/** How many setups reached each stage, and why the rest were dropped. */
export type SmcFunnel = { sweeps: number; choch: number; zones: number; entries: number; noChoch: number; invalidated: number; noZone: number; expired: number; stopTooWide: number; srTooClose: number; counterTrend: number; lateSession: number };
const emptyFunnel = (): SmcFunnel => ({ sweeps: 0, choch: 0, zones: 0, entries: 0, noChoch: 0, invalidated: 0, noZone: 0, expired: 0, stopTooWide: 0, srTooClose: 0, counterTrend: 0, lateSession: 0 });
/** Last minute (IST) at which a new SMC entry is allowed: later trades have no time to reach T2. */
const LAST_ENTRY_MINUTE = 14 * 60 + 30;

export function smcSignalSource(symbol: string, minute: Bar[], daily: Bar[]) {
  const m5 = aggregate(minute, 5);
  const funnel = emptyFunnel();
  const m15 = aggregate(minute, 15);
  let state = freshState();

  function freshState() {
    return {
      next1: 0, next5: 0, next15: 0,
      day: "", pdh: NaN, pdl: NaN, orHigh: -Infinity, orLow: Infinity, orDone: false,
      vwapPv: 0, vwapV: 0, vwapSum: 0, vwapN: 0, vwap: NaN,
      atr5: null as number | null, atr15: null as number | null,
      pools: [] as Pool[],
      setups: [] as Setup[],
      // 15m structure
      swingHigh15: NaN, swingLow15: NaN, bias15: 0 as -1 | 0 | 1,
      // 5m internal swings
      lastSwingHigh5: NaN, lastSwingLow5: NaN,
      sessionHigh: -Infinity, sessionLow: Infinity,
      /** Completed session ranges (most recent last), for the average daily range. */
      ranges: [] as number[],
      pending: null as Signal | null, pendingIndex: -1,
    };
  }

  function priorDaily(day: string) {
    const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000 - 330 * 60;
    for (let index = daily.length - 1; index >= 0; index -= 1) if (daily[index].time < dayStart && istDay(daily[index].time) < day) return daily[index];
    return null;
  }

  function startDay(day: string) {
    const s = state;
    const fromMinutes = Number.isFinite(s.sessionHigh) && s.day !== "";
    const prior = fromMinutes ? { high: s.sessionHigh, low: s.sessionLow } : priorDaily(day);
    if (fromMinutes) s.ranges = [...s.ranges, s.sessionHigh - s.sessionLow].slice(-10);
    s.day = day;
    s.pdh = prior ? prior.high : NaN;
    s.pdl = prior ? prior.low : NaN;
    s.sessionHigh = -Infinity; s.sessionLow = Infinity;
    s.orHigh = -Infinity; s.orLow = Infinity; s.orDone = false;
    s.vwapPv = 0; s.vwapV = 0; s.vwapSum = 0; s.vwapN = 0;
    s.setups = [];
    // Keep only recent unswept swing liquidity across days; daily/OR pools are re-added below.
    s.pools = s.pools.filter((pool) => !pool.swept && (pool.kind === "SWING" || pool.kind === "EQUAL")).slice(-12);
    if (Number.isFinite(s.pdh)) s.pools.push({ price: s.pdh, time: 0, kind: "PDH", side: 1, swept: false });
    if (Number.isFinite(s.pdl)) s.pools.push({ price: s.pdl, time: 0, kind: "PDL", side: -1, swept: false });
  }

  /** Average daily range: completed sessions in the data, topped up with prior daily bars. */
  function adr() {
    const s = state;
    const dayStart = Date.parse(`${s.day}T00:00:00Z`) / 1000 - 330 * 60;
    const fromDaily = daily.filter((bar) => bar.time < dayStart && istDay(bar.time) < s.day).slice(-10).map((bar) => bar.high - bar.low);
    const ranges = [...fromDaily.slice(0, Math.max(0, 10 - s.ranges.length)), ...s.ranges].filter((range) => range > 0);
    return ranges.length >= 3 ? ranges.reduce((sum, range) => sum + range, 0) / ranges.length : NaN;
  }

  function on1m(index: number) {
    const s = state;
    const bar = minute[index];
    const day = istDay(bar.time);
    if (day !== s.day) startDay(day);
    s.sessionHigh = Math.max(s.sessionHigh, bar.high); s.sessionLow = Math.min(s.sessionLow, bar.low);
    const minuteOfDay = istMinute(bar.time);
    if (minuteOfDay < 9 * 60 + 30) { s.orHigh = Math.max(s.orHigh, bar.high); s.orLow = Math.min(s.orLow, bar.low); }
    const typical = (bar.high + bar.low + bar.close) / 3;
    const volume = bar.volume ?? 0;
    s.vwapPv += typical * volume; s.vwapV += volume; s.vwapSum += typical; s.vwapN += 1;
    s.vwap = s.vwapV > 0 ? s.vwapPv / s.vwapV : s.vwapSum / s.vwapN;

    const t = bar.time + 60;
    if (!s.orDone && istMinute(t) >= 9 * 60 + 30 && Number.isFinite(s.orHigh)) {
      s.orDone = true;
      s.pools.push({ price: s.orHigh, time: t, kind: "ORH", side: 1, swept: false }, { price: s.orLow, time: t, kind: "ORL", side: -1, swept: false });
    }
    // Higher timeframes first: the 5m logic reads the 15m bias.
    while (s.next15 < m15.length && m15[s.next15].time + 900 <= t) on15m(s.next15++);
    while (s.next5 < m5.length && m5[s.next5].time + 300 <= t) on5m(s.next5++);
    trigger(index);
  }

  function on15m(k: number) {
    const s = state;
    const bar = m15[k];
    const prev = m15[k - 1];
    s.atr15 = wilder(s.atr15, prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low, 14);
    // Fractal swings (confirmed two bars later), then break of structure on a close.
    const p = k - PIVOT;
    if (p >= PIVOT) {
      const c = m15[p];
      const around = m15.slice(p - PIVOT, p + PIVOT + 1);
      if (around.every((other) => other === c || other.high < c.high)) s.swingHigh15 = c.high;
      if (around.every((other) => other === c || other.low > c.low)) s.swingLow15 = c.low;
    }
    if (Number.isFinite(s.swingHigh15) && bar.close > s.swingHigh15) s.bias15 = 1;
    else if (Number.isFinite(s.swingLow15) && bar.close < s.swingLow15) s.bias15 = -1;
  }

  function on5m(k: number) {
    const s = state;
    const bar = m5[k];
    const prev = m5[k - 1];
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    s.atr5 = wilder(s.atr5, tr, 14);
    const atr = s.atr5;
    const sameDay = istDay(bar.time) === s.day;

    // 1) Confirm swing pivots → liquidity pools (equal highs/lows when two swings line up).
    const p = k - PIVOT;
    if (p >= PIVOT && istDay(m5[p].time) === s.day) {
      const c = m5[p];
      const around = m5.slice(p - PIVOT, p + PIVOT + 1);
      const tolerance = Math.max(0.15 * atr, c.close * 0.0003);
      if (around.every((other) => other === c || other.high < c.high)) {
        s.lastSwingHigh5 = c.high;
        if (!(c.high < bar.high)) {
          const twin = s.pools.find((pool) => !pool.swept && pool.side === 1 && Math.abs(pool.price - c.high) <= tolerance);
          if (twin) { twin.kind = twin.kind === "SWING" ? "EQUAL" : twin.kind; twin.price = Math.max(twin.price, c.high); }
          else s.pools.push({ price: c.high, time: c.time, kind: "SWING", side: 1, swept: false });
        }
      }
      if (around.every((other) => other === c || other.low > c.low)) {
        s.lastSwingLow5 = c.low;
        if (!(c.low > bar.low)) {
          const twin = s.pools.find((pool) => !pool.swept && pool.side === -1 && Math.abs(pool.price - c.low) <= tolerance);
          if (twin) { twin.kind = twin.kind === "SWING" ? "EQUAL" : twin.kind; twin.price = Math.min(twin.price, c.low); }
          else s.pools.push({ price: c.low, time: c.time, kind: "SWING", side: -1, swept: false });
        }
      }
    }

    // 2) Advance existing setups with this closed 5m bar.
    for (const setup of s.setups) advanceSetup(setup, k, atr);
    s.setups = s.setups.filter((setup) => setup.barsLeft > 0);

    // 3) Sweeps: wick through an unswept pool, close back inside.
    if (!sameDay || istMinute(bar.time) < 9 * 60 + 30) { markTaken(bar); return; }
    const range = Math.max(bar.high - bar.low, 1e-9);
    const rank: Record<Pool["kind"], number> = { PDH: 4, PDL: 4, EQUAL: 3, ORH: 2, ORL: 2, SWING: 1 };
    const swept = (side: 1 | -1) => s.pools
      .filter((pool) => !pool.swept && pool.side === side && (side > 0 ? bar.high > pool.price && bar.close < pool.price : bar.low < pool.price && bar.close > pool.price))
      .sort((a, b) => rank[b.kind] - rank[a.kind])[0];
    const buySide = swept(1);
    const sellSide = swept(-1);
    markTaken(bar);
    if (buySide && !s.setups.some((setup) => setup.dir === -1)) {
      funnel.sweeps += 1;
      s.setups.push({ dir: -1, stage: "SWEPT", pool: buySide, sweepIndex: k, sweepExtreme: bar.high, sweepWick: (bar.high - Math.max(bar.open, bar.close)) / range, breakLevel: internalLevel(k, -1), barsLeft: 6 });
    }
    if (sellSide && !s.setups.some((setup) => setup.dir === 1)) {
      funnel.sweeps += 1;
      s.setups.push({ dir: 1, stage: "SWEPT", pool: sellSide, sweepIndex: k, sweepExtreme: bar.low, sweepWick: (Math.min(bar.open, bar.close) - bar.low) / range, breakLevel: internalLevel(k, 1), barsLeft: 6 });
    }
  }

  /** The internal swing a CHoCH must close through: the last 5m swing, or the 3-bar extreme before the sweep. */
  function internalLevel(k: number, dir: 1 | -1) {
    const s = state;
    const recent = m5.slice(Math.max(0, k - 3), k);
    const fallback = dir > 0 ? Math.max(...recent.map((bar) => bar.high), m5[k].high) : Math.min(...recent.map((bar) => bar.low), m5[k].low);
    const swing = dir > 0 ? s.lastSwingHigh5 : s.lastSwingLow5;
    const atr = s.atr5 ?? 0;
    if (Number.isFinite(swing) && (dir > 0 ? swing > m5[k].close : swing < m5[k].close) && Math.abs(swing - m5[k].close) <= 2.5 * atr) return swing;
    return fallback;
  }

  function markTaken(bar: Bar) {
    for (const pool of state.pools) if (!pool.swept && (pool.side > 0 ? bar.high > pool.price : bar.low < pool.price)) pool.swept = true;
  }

  /** Most recent fair value gap whose middle candle is at or after `firstMiddle`, at least 0.1 ATR wide. */
  function findFvg(firstMiddle: number, to: number, dir: 1 | -1) {
    const minSize = 0.1 * (state.atr5 ?? 0);
    for (let k = to; k >= Math.max(firstMiddle + 1, 2); k -= 1) {
      const a = m5[k - 2]; const c = m5[k];
      if (dir > 0 && c.low - a.high > minSize) return { lo: a.high, hi: c.low };
      if (dir < 0 && a.low - c.high > minSize) return { lo: c.high, hi: a.low };
    }
    return null;
  }

  function findOrderBlock(from: number, to: number, dir: 1 | -1) {
    for (let k = to; k >= Math.max(0, from); k -= 1) {
      const bar = m5[k];
      if (dir > 0 && bar.close < bar.open) return { lo: bar.low, hi: Math.max(bar.open, bar.close) };
      if (dir < 0 && bar.close > bar.open) return { lo: Math.min(bar.open, bar.close), hi: bar.high };
    }
    return null;
  }

  function advanceSetup(setup: Setup, k: number, atr: number) {
    const bar = m5[k];
    const dir = setup.dir;
    // Invalidated: a 5m close beyond the sweep extreme means the level did not hold.
    if ((bar.close - setup.sweepExtreme) * dir < 0) { setup.barsLeft = 0; funnel.invalidated += 1; return; }
    if (setup.stage === "ARMED") { setup.barsLeft -= 1; if (setup.barsLeft === 0) funnel.expired += 1; return; }
    if (setup.stage === "SWEPT") {
      if (k === setup.sweepIndex) return;
      setup.barsLeft -= 1;
      const body = Math.abs(bar.close - bar.open);
      const range = Math.max(bar.high - bar.low, 1e-9);
      const displaced = (bar.close - bar.open) * dir > 0 && body >= 0.6 * atr && body / range >= 0.5;
      if (displaced && (bar.close - setup.breakLevel) * dir > 0) {
        funnel.choch += 1;
        setup.displacement = body / Math.max(atr, 1e-9);
        setup.chochBars = k - setup.sweepIndex;
        setup.stage = "WAIT_ZONE";
        setup.barsLeft = 3;
        locateZone(setup, k);
      } else if (setup.barsLeft === 0) funnel.noChoch += 1;
      return;
    }
    // WAIT_ZONE: an FVG can complete one or two bars after the displacement candle.
    setup.barsLeft -= 1;
    locateZone(setup, k);
  }

  function locateZone(setup: Setup, k: number) {
    const fvg = findFvg(setup.sweepIndex + 1, k, setup.dir); // the displacement leg starts after the sweep candle
    const ob = findOrderBlock(setup.sweepIndex - 2, k - 1, setup.dir);
    if (!fvg && setup.barsLeft > 1) return; // give the FVG a chance to form
    const zone = fvg ?? ob;
    if (!zone) { setup.barsLeft = 0; funnel.noZone += 1; return; }
    funnel.zones += 1;
    const overlap = Boolean(fvg && ob && fvg.lo <= ob.hi && ob.lo <= fvg.hi);
    setup.zone = { ...zone, kind: fvg ? (overlap ? "FVG+OB" : "FVG") : "OB" };
    setup.stage = "ARMED";
    setup.armedAt = m5[k].time + 300;
    setup.expiresAt = setup.armedAt + 60 * 60;
    setup.barsLeft = 12;
  }

  /** 1m candle-psychology trigger inside an armed zone. Emits a signal at this bar's close. */
  function trigger(index: number) {
    const s = state;
    const bar = minute[index];
    const t = bar.time + 60;
    const prev = minute[index - 1];
    for (const setup of s.setups) {
      if (setup.stage !== "ARMED" || !setup.zone || setup.armedAt === undefined || bar.time < setup.armedAt) continue;
      if (t > (setup.expiresAt ?? 0)) { setup.barsLeft = 0; funnel.expired += 1; continue; }
      const dir = setup.dir;
      const zone = setup.zone;
      const atr = s.atr5 ?? Math.max(bar.high - bar.low, 1);
      const buffer = Math.max(0.1 * atr, bar.close * 0.0002);
      const stop = setup.sweepExtreme - dir * buffer;
      if ((bar.close - stop) * dir <= 0) { setup.barsLeft = 0; funnel.invalidated += 1; continue; }
      const touched = dir > 0 ? bar.low <= zone.hi : bar.high >= zone.lo;
      if (!touched) continue;
      const range = Math.max(bar.high - bar.low, 1e-9);
      const lowerWick = (Math.min(bar.open, bar.close) - bar.low) / range;
      const upperWick = (bar.high - Math.max(bar.open, bar.close)) / range;
      const wick = dir > 0 ? lowerWick : upperWick;
      const directional = (bar.close - bar.open) * dir > 0;
      const engulfing = Boolean(prev && directional && (prev.close - prev.open) * dir < 0 && (bar.close - prev.open) * dir >= 0 && (bar.open - prev.close) * dir <= 0);
      const reclaimed = dir > 0 ? bar.close > zone.hi : bar.close < zone.lo;
      const rejection = wick >= 0.45 && (bar.close - (bar.high + bar.low) / 2) * dir >= 0;
      // Strong close: a directional candle that tested the zone and closed in its top (bottom) third.
      const strongClose = directional && (dir > 0 ? (bar.close - bar.low) / range >= 0.67 : (bar.high - bar.close) / range >= 0.67);
      if (!(engulfing || rejection || (directional && reclaimed) || strongClose)) continue;
      const clock = istMinute(t);
      if (clock > LAST_ENTRY_MINUTE) { setup.barsLeft = 0; funnel.lateSession += 1; continue; }
      const entry = bar.close;
      let risk = (entry - stop) * dir;
      if (risk > 2.5 * atr) { setup.barsLeft = 0; funnel.stopTooWide += 1; continue; } // structural stop too wide for intraday
      const finalStop = risk < 0.35 * atr ? entry - dir * 0.35 * atr : stop;
      risk = (entry - finalStop) * dir;
      // Opposing liquidity / S/R between here and the targets.
      const opposing = s.pools
        .filter((pool) => !pool.swept && pool.side === dir && (pool.price - entry) * dir > 0)
        .map((pool) => ({ pool, distance: (pool.price - entry) * dir }))
        .sort((a, b) => a.distance - b.distance);
      const nearest = opposing[0];
      if (nearest && nearest.distance < 1 * risk) { setup.barsLeft = 0; funnel.srTooClose += 1; continue; } // walking into S/R
      const t1Distance = nearest && nearest.distance < 1.5 * risk ? Math.max(risk, nearest.distance - 0.05 * risk) : 1.5 * risk;
      // T2: the next opposing liquidity beyond T1 (front-run by 0.05R), capped at 4R; 3R when the path
      // is clear. Never place T2 behind a level price has to break first.
      const nextWall = opposing.find((item) => item.distance > t1Distance + 0.25 * risk);
      const t2Distance = nextWall ? Math.min(4 * risk, Math.max(t1Distance + 0.25 * risk, nextWall.distance - 0.05 * risk)) : 3 * risk;

      // Confluence score.
      const daily = setup.pool.kind === "PDH" || setup.pool.kind === "PDL";
      const aligned = s.bias15 === dir;
      const against = s.bias15 === -dir;
      if (against && !daily) { setup.barsLeft = 0; funnel.counterTrend += 1; continue; }
      const rangeHigh = s.swingHigh15; const rangeLow = s.swingLow15;
      const position = Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh > rangeLow ? (entry - rangeLow) / (rangeHigh - rangeLow) : 0.5;
      const discountOk = dir > 0 ? position <= 0.5 : position >= 0.5;
      const vwapOk = Number.isFinite(s.vwap) && (entry - s.vwap) * dir >= 0;
      let confidence = 45;
      const reasons: string[] = [];
      if (daily) { confidence += 15; reasons.push("daily level"); }
      else if (setup.pool.kind === "EQUAL") { confidence += 8; reasons.push("equal highs/lows"); }
      else if (setup.pool.kind === "ORH" || setup.pool.kind === "ORL") { confidence += 6; reasons.push("opening range"); }
      if (aligned) { confidence += 12; reasons.push(`15m ${dir > 0 ? "bullish" : "bearish"} structure`); } else if (against) confidence -= 10;
      if (discountOk) { confidence += 8; reasons.push(dir > 0 ? "discount" : "premium"); }
      if (vwapOk) { confidence += 5; reasons.push(`${dir > 0 ? "above" : "below"} VWAP`); }
      if (zone.kind === "FVG+OB") { confidence += 8; reasons.push("FVG inside order block"); }
      if ((setup.displacement ?? 0) >= 1) { confidence += 7; reasons.push("strong displacement"); }
      if (setup.sweepWick >= 0.4) { confidence += 7; reasons.push("rejection wick on the sweep"); }
      if (engulfing) { confidence += 5; reasons.push("1m engulfing"); }
      if (t2Distance >= 2.5 * risk) confidence += 5;
      // Session timing.
      if (clock >= 9 * 60 + 30 && clock <= 11 * 60 + 30) { confidence += 5; reasons.push("morning liquidity window"); }
      else if (clock >= 11 * 60 + 45 && clock <= 13 * 60 + 15) { confidence -= 8; reasons.push("midday chop (−)"); }
      // Exhaustion: how much of the usual daily range has already been used.
      const averageRange = adr();
      const extended = Number.isFinite(averageRange) && s.sessionHigh - s.sessionLow > 1.2 * averageRange;
      if (extended && aligned && !daily) { confidence -= 8; reasons.push("day already beyond 1.2× ADR: late trend entry (−)"); }
      else if (extended && daily) { confidence += 5; reasons.push("exhausted move trapped at a daily level"); }
      // Conviction of the rejection.
      if ((setup.chochBars ?? 99) <= 2) { confidence += 5; reasons.push("fast rejection (CHoCH within 2 candles)"); }
      confidence = Math.max(0, Math.min(100, Math.round(confidence)));

      const pattern = engulfing ? `1m ${dir > 0 ? "bullish" : "bearish"} engulfing` : rejection ? `1m ${dir > 0 ? "hammer/pin-bar" : "shooting-star"} rejection` : reclaimed ? `1m close back ${dir > 0 ? "above" : "below"} the zone` : `1m strong ${dir > 0 ? "bullish" : "bearish"} close off the zone`;
      const reason = `${dir > 0 ? "Buy CE" : "Buy PE"}: swept ${KIND_LABEL[setup.pool.kind]} ${fmt(setup.pool.price)} (${dir > 0 ? "sell" : "buy"}-side liquidity) → ${dir > 0 ? "bullish" : "bearish"} CHoCH through ${fmt(setup.breakLevel)} → retrace into ${zone.kind} ${fmt(zone.lo)}–${fmt(zone.hi)} → ${pattern}${reasons.length ? `. Confluence: ${reasons.join(", ")}` : ""}.`;
      setup.barsLeft = 0; // one trade per setup
      funnel.entries += 1;
      if (index === s.pendingIndex || s.pending === null) { s.pending = { time: t, side: dir, stop: Math.round(finalStop * 100) / 100, target1: Math.round((entry + dir * t1Distance) * 100) / 100, target2: Math.round((entry + dir * t2Distance) * 100) / 100, confidence, strategy: SMC_NAME, reason }; s.pendingIndex = index; }
    }
    s.setups = s.setups.filter((setup) => setup.barsLeft > 0);
  }

  const source = (index: number): Signal | null => {
    if (index < state.next1 - 1) { state = freshState(); Object.assign(funnel, emptyFunnel()); }
    while (state.next1 <= index) {
      state.pending = null; state.pendingIndex = -1;
      on1m(state.next1);
      state.next1 += 1;
    }
    return state.pendingIndex === index ? state.pending : null;
  };
  return Object.assign(source, { funnel });
}
