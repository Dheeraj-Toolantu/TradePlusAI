import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { aggregate, istDay, istMinute, type Signal } from "./strategy-backtest";

/**
 * SMC liquidity-sweep strategy v2 ("sweep → shift → retrace, with the 9 EMA trend").
 *
 * The idea a discretionary index trader would trade, written as rules:
 *  1. Map liquidity and support/resistance: previous-day high/low (PDH/PDL), the 09:15–09:30 opening
 *     range, unswept 5-minute swing highs/lows, and equal highs/lows (resting stops cluster there).
 *  2. Wait for a LIQUIDITY SWEEP: a 5m candle trades through a level and closes back inside it.
 *     Stops above/below the level have been taken; if smart money was absorbing, price should reverse.
 *  3. Demand proof: a CHANGE OF CHARACTER (CHoCH) within six 5m bars — a displacement candle (big
 *     body, closes on its extreme) that closes through the last internal swing in the new direction.
 *  4. Entry zone: the FAIR VALUE GAP left by the displacement (3-candle imbalance), else the ORDER
 *     BLOCK (last opposite candle before the move). Wait for price to RETRACE into it (no retrace
 *     within an hour = no trade; never chase).
 *  5. TREND CONFIRMATION with the 9 EMA: only trade in the direction of the 15-minute 9 EMA — the last
 *     closed 15m candle is beyond the EMA and the EMA slopes the trade's way — and with the 1m close on
 *     the trade's side of VWAP. A sweep against the 15m 9 EMA is a trap more often than a reversal.
 *  6. Trigger: after the zone is tapped, a 1m candle in the trade's direction that CLOSES back out of
 *     the zone (the zone held). A wick or pin bar that closes inside the zone is not enough.
 *  7. Stop beyond the sweep extreme (the level that must hold for the idea to be right). T1 at 1R (or
 *     the nearest opposing liquidity if closer), then breakeven and a trailing runner / T2 at the next
 *     opposing liquidity pool. Skip when opposing S/R sits closer than 1R, the stop is wider than
 *     2.5 ATR (5m), or it is after 14:30.
 *  8. Confidence: entry at value (within 0.3 ATR of the 5m 9 EMA, not stretched away from it), an FVG
 *     inside the order block, and a daily-level sweep add conviction.
 *
 * Validation on real 1-minute index data, Jan 2018 – Oct 2026 (BANKNIFTY to Apr 2026), index points,
 * 1-pt slippage per side, half at T1, 1.5R trail, 45-min time stop:
 *   NIFTY      v1 206 trades, 45% win, -0.05R/trade, PF 1.14  →  v2  82 trades, 59% win, +0.19R, PF 1.64
 *   BANKNIFTY  v1 215 trades, 41% win, -0.12R/trade, PF 0.86  →  v2  94 trades, 55% win, +0.19R, PF 1.70
 * BANKNIFTY was not used to design the rules. Without the 15m 9 EMA gate v2 makes PF 1.36 (NIFTY) and
 * 1.40 (BANKNIFTY). With minimum confidence 65: NIFTY 53 trades, 60% win, +0.27R; BANKNIFTY 63
 * trades, 59% win, +0.29R. Few trades (~10 a year): this is an A+ setup filter, not a daily signal.
 *
 * Timeframes: liquidity, CHoCH/BOS, FVGs, order blocks and the retest zone are all read on 5m candles; the
 * trigger is a 1m close. Only the trend filter uses 15m. Tested alternatives on the same data (NIFTY):
 * a 5m 9 EMA trend filter instead of 15m → 67 trades, +0.11R, PF 1.47; confirming the retest on a 5m
 * close instead of 1m → 24 trades, −0.02R. Both were worse, so the 15m 9 EMA and the 1m close stay.
 *
 * `chochRetest: true` ("SMC sweep + CHoCH retest") adds a 5m CHoCH continuation entry and lets sweeps also
 * use the 5m 9 EMA trend. Real data 2018–2026 (1.5R trail, 45-min time stop), vs the earlier BOS-retest
 * version (BOS with displacement → retest ≥ 20 min later → plain 1m close back):
 *   NIFTY      BOS version 166 trades, 58% win, +0.21R, PF 1.86  →  CHoCH version 191 trades, 58% win, +0.18R, PF 1.60
 *   BANKNIFTY  BOS version 178 trades, 50% win, +0.06R, PF 1.18  →  CHoCH version 207 trades, 54% win, +0.13R, PF 1.38
 * Continuation entries alone: NIFTY 93 trades, 57% win, +0.16R; BANKNIFTY 89 trades, 56% win, +0.11R (the BOS
 * retests there: 47%, −0.04R). No losing year on NIFTY (the BOS version lost in 2018 and 2019).
 * What was tested for the continuation entry (NIFTY 2018–22 / 2023–26 / BANKNIFTY): BOS vs CHoCH (CHoCH was
 * positive in all three, BOS lost on BANKNIFTY); 1m confirmation = close back out / strong close / engulfing /
 * close beyond the 1m 9 EMA / two closes out (strong close: most trades at similar quality); retest wait
 * 0–20 min (0 with a strong close); T1 0.75R (more T1 hits, lower expectancy, not used).
 *
 * `legacy: true` keeps the original v1 rules (any 1m candle pattern in the zone, 15m BOS bias,
 * T1 1.5R, session/exhaustion scoring); the Smart combo router still uses them for range-day fades.
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
  /** 1m index of the first touch of the zone (v2 waits for a confirming close after it). */
  tappedAt?: number;
  /** Last v2 gate that held a confirmed trigger back, for the funnel if the setup then expires. */
  blocked?: "EMA" | "VWAP";
  /** SWEEP = liquidity sweep → CHoCH (default); CHOCH = 5m CHoCH continuation in the 15m trend → retest. */
  model?: "SWEEP" | "CHOCH";
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
export type SmcFunnel = { sweeps: number; choch: number; zones: number; entries: number; noChoch: number; invalidated: number; noZone: number; expired: number; stopTooWide: number; srTooClose: number; counterTrend: number; againstEma: number; chochBreaks: number; chochEntries: number; againstVwap: number; lateSession: number };
const emptyFunnel = (): SmcFunnel => ({ sweeps: 0, choch: 0, zones: 0, entries: 0, noChoch: 0, invalidated: 0, noZone: 0, expired: 0, stopTooWide: 0, srTooClose: 0, counterTrend: 0, againstEma: 0, chochBreaks: 0, chochEntries: 0, againstVwap: 0, lateSession: 0 });
/** Last minute (IST) at which a new SMC entry is allowed: later trades have no time to reach T2. */
const LAST_ENTRY_MINUTE = 14 * 60 + 30;

export type SmcOptions = {
  /** The original (v1) rules: any 1m candle pattern in the zone, 15m BOS bias, T1 1.5R, no 9 EMA/VWAP gate. */
  legacy?: boolean;
  /**
   * "SMC sweep + CHoCH retest": add the 5m CHoCH continuation entry — the 5m pullback's structure (last
   * swing break against the trade) flips back with a displacement candle (body ≥ 0.8 ATR) in the 15m 9 EMA
   * trend's direction → its FVG / order block → retest → 1m strong close back out of the zone. Sweep
   * entries in this mode also accept a 5m 9 EMA trend (5m close beyond a sloping 5m 9 EMA) when the
   * 15m one has not turned yet. See the validation notes in the header.
   */
  chochRetest?: boolean;
};
/** CHoCH-retest entry: minimum displacement body (in 5m ATR) and the impulse-leg lookback (5m bars) for the stop. */
const CHOCH_BODY_ATR = 0.8;
const CHOCH_LEG_BARS = 6;
const ema = (prev: number, value: number, period: number) => (Number.isFinite(prev) ? prev + (2 / (period + 1)) * (value - prev) : value);

export function smcSignalSource(symbol: string, minute: Bar[], daily: Bar[], options: SmcOptions = {}) {
  const legacy = options.legacy === true;
  const chochRetest = !legacy && options.chochRetest === true;
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
      ema5: NaN, ema5Hist: [] as number[], close5: NaN, struct5: 0 as -1 | 0 | 1, ema15: NaN, ema15Hist: [] as number[], close15: NaN,
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
    s.ema15 = ema(s.ema15, bar.close, 9); s.ema15Hist = [...s.ema15Hist, s.ema15].slice(-3); s.close15 = bar.close;
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
    s.ema5 = ema(s.ema5, bar.close, 9); s.ema5Hist = [...s.ema5Hist, s.ema5].slice(-3); s.close5 = bar.close;
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

    // 5m market structure: the side of the last close through a confirmed swing.
    const priorStruct = s.struct5;
    if (Number.isFinite(s.lastSwingHigh5) && bar.close > s.lastSwingHigh5) s.struct5 = 1;
    else if (Number.isFinite(s.lastSwingLow5) && bar.close < s.lastSwingLow5) s.struct5 = -1;

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
    // 4) CHoCH-retest continuation (optional): a displacement candle that is the first close through the
    // last 5m swing AGAINST the 5m structure (the pullback's lower highs / higher lows), i.e. a 5m change
    // of character. Breaks in the direction the 5m structure already had (BOS) are not traded: on real
    // data they lost on BANKNIFTY. The 15m 9 EMA trend gate is applied at the trigger.
    if (chochRetest) for (const dir of [1, -1] as const) {
      if (priorStruct === dir) continue;
      const level = dir > 0 ? s.lastSwingHigh5 : s.lastSwingLow5;
      const body = Math.abs(bar.close - bar.open);
      const displaced = (bar.close - bar.open) * dir > 0 && body >= CHOCH_BODY_ATR * atr && body / range >= 0.5;
      if (!Number.isFinite(level) || !displaced || !prev || (bar.close - level) * dir <= 0 || (prev.close - level) * dir > 0) continue;
      // A bar that also swept the opposite side is a two-sided liquidity grab, not a clean break.
      if (s.setups.some((setup) => setup.dir === dir) || (dir > 0 ? buySide : sellSide)) continue;
      // The stop goes beyond the origin of the impulse leg: the extreme of the last six 5m bars.
      const leg = m5.slice(Math.max(0, k - CHOCH_LEG_BARS), k + 1);
      const origin = dir > 0 ? Math.min(...leg.map((item) => item.low)) : Math.max(...leg.map((item) => item.high));
      funnel.chochBreaks += 1;
      const setup: Setup = { dir, stage: "WAIT_ZONE", model: "CHOCH", pool: { price: level, time: bar.time, kind: "SWING", side: dir, swept: true }, sweepIndex: k - 1, sweepExtreme: origin, sweepWick: 0, breakLevel: level, displacement: body / Math.max(atr, 1e-9), chochBars: 1, barsLeft: 3 };
      s.setups.push(setup);
      locateZone(setup, k);
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
    if (setup.stage === "ARMED") { setup.barsLeft -= 1; if (setup.barsLeft === 0) expire(setup); return; }
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

  /** A setup that ran out of time: counted against the v2 gate that held it back, if any. */
  function expire(setup: Setup) {
    if (setup.blocked === "EMA") funnel.againstEma += 1;
    else if (setup.blocked === "VWAP") funnel.againstVwap += 1;
    else funnel.expired += 1;
  }

  /**
   * v2 confidence, kept to what held up on real NIFTY/BANKNIFTY 1-minute data (2018–2026): entering at
   * value near the 5m 9 EMA (not stretched away from it), an FVG inside the order block, and a sweep
   * of a daily level. The 15m 9 EMA trend and VWAP side are already hard requirements.
   */
  function v2Score(args: { setup: Setup; dir: 1 | -1; entry: number; atr: number; vwapOk: boolean }) {
    const s = state;
    const { setup, dir, entry, atr, vwapOk } = args;
    let confidence = 60;
    const reasons = [`15m 9 EMA ${dir > 0 ? "up" : "down"}trend`];
    if (vwapOk) reasons.push(`${dir > 0 ? "above" : "below"} VWAP`);
    const stretch = (entry - s.ema5) * dir / Math.max(atr, 1e-9);
    if (stretch <= 0.3) { confidence += 12; reasons.push(`entry at value (within 0.3 ATR of the 5m 9 EMA ${fmt(s.ema5)})`); }
    else if (stretch > 1) { confidence -= 5; reasons.push("stretched > 1 ATR from the 5m 9 EMA (−)"); }
    if (setup.zone?.kind === "FVG+OB") { confidence += 8; reasons.push("FVG inside order block"); }
    if (setup.pool.kind === "PDH" || setup.pool.kind === "PDL") { confidence += 6; reasons.push("daily level"); }
    return { confidence: Math.max(0, Math.min(100, Math.round(confidence))), reasons };
  }

  /** v1 confluence score; null = counter-trend against the 15m structure off a non-daily level (skip). */
  function legacyScore(args: { setup: Setup; dir: 1 | -1; entry: number; risk: number; clock: number; engulfing: boolean; t2Distance: number }) {
    const s = state;
    const { setup, dir, entry, risk, clock, engulfing, t2Distance } = args;
    const daily = setup.pool.kind === "PDH" || setup.pool.kind === "PDL";
    const aligned = s.bias15 === dir;
    const against = s.bias15 === -dir;
    if (against && !daily) return null;
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
    if (setup.zone?.kind === "FVG+OB") { confidence += 8; reasons.push("FVG inside order block"); }
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
    return { confidence: Math.max(0, Math.min(100, Math.round(confidence))), reasons };
  }

  /** 1m candle-psychology trigger inside an armed zone. Emits a signal at this bar's close. */
  function trigger(index: number) {
    const s = state;
    const bar = minute[index];
    const t = bar.time + 60;
    const prev = minute[index - 1];
    for (const setup of s.setups) {
      if (setup.stage !== "ARMED" || !setup.zone || setup.armedAt === undefined || bar.time < setup.armedAt) continue;
      if (t > (setup.expiresAt ?? 0)) { setup.barsLeft = 0; expire(setup); continue; }
      const dir = setup.dir;
      const zone = setup.zone;
      const atr = s.atr5 ?? Math.max(bar.high - bar.low, 1);
      const buffer = Math.max(0.1 * atr, bar.close * 0.0002);
      const stop = setup.sweepExtreme - dir * buffer;
      if ((bar.close - stop) * dir <= 0) { setup.barsLeft = 0; funnel.invalidated += 1; continue; }
      const touched = dir > 0 ? bar.low <= zone.hi : bar.high >= zone.lo;
      if (touched) setup.tappedAt ??= index;
      // v2 waits for the confirming close after the first tap; legacy needs the trigger bar itself in the zone.
      if (legacy ? !touched : setup.tappedAt === undefined) continue;
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
      // v2 trigger: a directional 1m candle closing back out of the zone; for the CHoCH retest it must also
      // close in its outer third (a strong close: the zone was defended, not just left).
      const confirmed = directional && reclaimed && (setup.model !== "CHOCH" || strongClose);
      if (legacy ? !(engulfing || rejection || (directional && reclaimed) || strongClose) : !confirmed) continue;
      // v2 trend confirmation: the 15m close is beyond a 9 EMA sloping the trade's way (in CHoCH-retest mode a
      // sweep may also use the 5m 9 EMA), and for sweeps the 1m close is on the trade's side of VWAP. A setup
      // that fails waits (it may still qualify before expiry).
      const ema15Ok = (s.close15 - s.ema15) * dir > 0 && ((s.ema15Hist.at(-1) ?? NaN) - (s.ema15Hist.at(-3) ?? NaN)) * dir > 0;
      const ema5Ok = (s.close5 - s.ema5) * dir > 0 && ((s.ema5Hist.at(-1) ?? NaN) - (s.ema5Hist.at(-3) ?? NaN)) * dir > 0;
      const trendTf = ema15Ok ? "15m" : chochRetest && setup.model !== "CHOCH" && ema5Ok ? "5m" : null;
      const vwapOk = Number.isFinite(s.vwap) && (bar.close - s.vwap) * dir >= 0;
      if (!legacy && !trendTf) { setup.blocked = "EMA"; continue; }
      // VWAP is not required for the CHoCH retest: in a trend pullback price often dips through VWAP.
      if (!legacy && !vwapOk && setup.model !== "CHOCH") { setup.blocked = "VWAP"; continue; }
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
      // T1: 1R in v2 (1.5R legacy), or the nearest opposing liquidity if closer (front-run by 0.05R, min 1R).
      const t1R = legacy ? 1.5 : 1;
      const t1Distance = nearest && nearest.distance < t1R * risk ? Math.max(risk, nearest.distance - 0.05 * risk) : t1R * risk;
      // T2: the next opposing liquidity beyond T1 (front-run by 0.05R), capped at 4R; 3R when the path
      // is clear. Never place T2 behind a level price has to break first.
      const nextWall = opposing.find((item) => item.distance > t1Distance + 0.25 * risk);
      const t2Distance = nextWall ? Math.min(4 * risk, Math.max(t1Distance + 0.25 * risk, nextWall.distance - 0.05 * risk)) : 3 * risk;

      const scored = legacy ? legacyScore({ setup, dir, entry, risk, clock, engulfing, t2Distance }) : v2Score({ setup, dir, entry, atr, vwapOk });
      if (scored === null) { setup.barsLeft = 0; funnel.counterTrend += 1; continue; }
      const { confidence, reasons } = scored;
      const candle = engulfing ? `${dir > 0 ? "bullish" : "bearish"} engulfing` : rejection ? `${dir > 0 ? "hammer/pin-bar" : "shooting-star"} rejection` : null;
      const pattern = legacy
        ? candle ? `1m ${candle}` : reclaimed ? `1m close back ${dir > 0 ? "above" : "below"} the zone` : `1m strong ${dir > 0 ? "bullish" : "bearish"} close off the zone`
        : `1m close back ${dir > 0 ? "above" : "below"} the zone${candle ? ` (${candle})` : ""}`;
      const trend = legacy ? "" : ` with the ${trendTf} 9 EMA ${dir > 0 ? "rising" : "falling"} (${fmt(trendTf === "5m" ? s.ema5 : s.ema15)})${vwapOk ? ` and price ${dir > 0 ? "above" : "below"} VWAP` : ""}`;
      const reason = setup.model === "CHOCH"
        ? `${dir > 0 ? "Buy CE" : "Buy PE"}: 5m pullback ends with a ${dir > 0 ? "bullish" : "bearish"} CHoCH through the swing ${fmt(setup.breakLevel)} with displacement → retest of the ${zone.kind} ${fmt(zone.lo)}–${fmt(zone.hi)} → ${pattern}${strongClose ? " (strong close)" : ""}${trend}${reasons.length ? `. Confluence: ${reasons.join(", ")}` : ""}.`
        : `${dir > 0 ? "Buy CE" : "Buy PE"}: swept ${KIND_LABEL[setup.pool.kind]} ${fmt(setup.pool.price)} (${dir > 0 ? "sell" : "buy"}-side liquidity) → ${dir > 0 ? "bullish" : "bearish"} CHoCH through ${fmt(setup.breakLevel)} → retrace into ${zone.kind} ${fmt(zone.lo)}–${fmt(zone.hi)} → ${pattern}${trend}${reasons.length ? `. Confluence: ${reasons.join(", ")}` : ""}.`;
      setup.barsLeft = 0; // one trade per setup
      funnel.entries += 1;
      if (setup.model === "CHOCH") funnel.chochEntries += 1;
      if (index === s.pendingIndex || s.pending === null) { s.pending = { time: t, side: dir, stop: Math.round(finalStop * 100) / 100, target1: Math.round((entry + dir * t1Distance) * 100) / 100, target2: Math.round((entry + dir * t2Distance) * 100) / 100, confidence, strategy: setup.model === "CHOCH" ? "SMC CHoCH retest" : SMC_NAME, reason }; s.pendingIndex = index; }
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
