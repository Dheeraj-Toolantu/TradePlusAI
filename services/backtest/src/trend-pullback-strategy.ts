import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { aggregate, istDay, istMinute, type Signal } from "./strategy-backtest";

/**
 * Trend-day VWAP pullback ("trade only the days that trend, buy the dip into value, let it run").
 *
 * Why this shape: an intraday option buyer loses on chop (theta + charges + whipsaw) and makes the
 * year on a handful of trend days. So the strategy is built for positive skew rather than win rate:
 *
 *  1. REGIME — is today a trend day? All of:
 *     - the session is moving efficiently, not rotating: Kaufman efficiency (net move ÷ sum of 5m
 *       moves since the open) ≥ 0.30 — chop days go nowhere with lots of travel;
 *     - real progress: ≥ 0.35× the average daily range (ADR) from the open, and price sitting in the
 *       top (bottom) 45% of the day's range — trend days keep printing new extremes;
 *     - price has closed on one side of a sloping session VWAP for the last 30 minutes;
 *     - the 15m chart agrees: last 15m close beyond a rising (falling) 15m EMA20.
 *  2. LOCATION — wait for a pullback into value: a 5m low (high) tags the 5m EMA20 or VWAP
 *     (± 0.3 ATR) without a 5m close through VWAP. On a real trend day VWAP is far behind; the EMA20
 *     is where trend traders reload.
 *  3. TRIGGER — trend resumes: a 5m candle in the trend direction that closes in the top 40% of its
 *     range and beyond the previous candle's high (low) or engulfs it, back above (below) EMA20.
 *     Never more than 1.5 ATR beyond the EMA20 (no chasing).
 *  4. RISK — stop beyond the pullback's 3-bar extreme with a 0.15 ATR buffer; a stop tighter than
 *     0.6 ATR is widened (noise kills tight stops), wider than 1.6 ATR is skipped.
 *  5. EXIT — half at 1.5R, stop to breakeven, runner trailed 1.5R behind the best price (simulator
 *     `trailR`) or T2 at 4R; 45-minute time stop if the trade has not reached +0.5R.
 *  6. DISCIPLINE — entries 10:00–14:15 only; one entry per pullback (a new tag of value is needed
 *     before the next); max entries per day are enforced by the simulator's risk rules.
 *
 * Decisions use only closed 5m/15m bars; the signal is stamped at the 5m close.
 */

const NAME = "Trend-day VWAP pullback";
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 1 });

export type TrendFunnel = { evaluated: number; trendBars: number; pullbacks: number; triggers: number; tooWide: number; extended: number };

export function trendPullbackSignalSource(_symbol: string, minute: Bar[], daily: Bar[]) {
  const m5 = aggregate(minute, 5);
  const m15 = aggregate(minute, 15);
  const funnel: TrendFunnel = { evaluated: 0, trendBars: 0, pullbacks: 0, triggers: 0, tooWide: 0, extended: 0 };
  let state = fresh();

  function fresh() {
    return {
      next1: 0, next5: 0, next15: 0,
      day: "", dayOpen: NaN, dayHigh: -Infinity, dayLow: Infinity, orHigh: -Infinity, orLow: Infinity,
      pv: 0, v: 0, tpSum: 0, n: 0, vwap: NaN,
      ranges: [] as number[],
      atr5: null as number | null, ema5: null as number | null, ema15: null as number | null,
      ema15History: [] as number[], close15: NaN,
      today5: [] as Array<{ bar: Bar; vwap: number; ema: number }>,
      lastSignalBar: { long: -1, short: -1 },
      pending: null as Signal | null, pendingIndex: -1,
    };
  }

  const ema = (prev: number | null, value: number, period: number) => (prev === null ? value : prev + (2 / (period + 1)) * (value - prev));

  function adr() {
    const s = state;
    const dayStart = Date.parse(`${s.day}T00:00:00Z`) / 1000 - 330 * 60;
    const fromDaily = daily.filter((bar) => bar.time < dayStart && istDay(bar.time) < s.day).slice(-10).map((bar) => bar.high - bar.low);
    const ranges = [...fromDaily.slice(0, Math.max(0, 10 - s.ranges.length)), ...s.ranges].filter((range) => range > 0);
    return ranges.length >= 3 ? ranges.reduce((sum, range) => sum + range, 0) / ranges.length : NaN;
  }

  function startDay(day: string, open: number) {
    const s = state;
    if (s.day !== "" && Number.isFinite(s.dayHigh)) s.ranges = [...s.ranges, s.dayHigh - s.dayLow].slice(-10);
    s.day = day; s.dayOpen = open; s.dayHigh = -Infinity; s.dayLow = Infinity; s.orHigh = -Infinity; s.orLow = Infinity;
    s.pv = 0; s.v = 0; s.tpSum = 0; s.n = 0; s.vwap = NaN; s.today5 = []; s.lastSignalBar = { long: -1, short: -1 };
  }

  function on1m(index: number) {
    const s = state;
    const bar = minute[index];
    const day = istDay(bar.time);
    if (day !== s.day) startDay(day, bar.open);
    s.dayHigh = Math.max(s.dayHigh, bar.high); s.dayLow = Math.min(s.dayLow, bar.low);
    if (istMinute(bar.time) < 9 * 60 + 45) { s.orHigh = Math.max(s.orHigh, bar.high); s.orLow = Math.min(s.orLow, bar.low); }
    const typical = (bar.high + bar.low + bar.close) / 3;
    const volume = bar.volume ?? 0;
    s.pv += typical * volume; s.v += volume; s.tpSum += typical; s.n += 1;
    s.vwap = s.v > 0 ? s.pv / s.v : s.tpSum / s.n;
    const t = bar.time + 60;
    while (s.next15 < m15.length && m15[s.next15].time + 900 <= t) on15m(s.next15++);
    while (s.next5 < m5.length && m5[s.next5].time + 300 <= t) on5m(s.next5++, index, t);
  }

  function on15m(k: number) {
    const s = state;
    s.ema15 = ema(s.ema15, m15[k].close, 20);
    s.ema15History = [...s.ema15History, s.ema15].slice(-3);
    s.close15 = m15[k].close;
  }

  function on5m(k: number, index: number, t: number) {
    const s = state;
    const bar = m5[k];
    const prev = m5[k - 1];
    const firstOfDay = !prev || istDay(prev.time) !== istDay(bar.time);
    const tr = firstOfDay ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
    s.atr5 = s.atr5 === null ? tr : (s.atr5 * 13 + tr) / 14;
    s.ema5 = ema(s.ema5, bar.close, 20);
    if (istDay(bar.time) !== s.day) return;
    s.today5.push({ bar, vwap: s.vwap, ema: s.ema5 });
    const clock = istMinute(t);
    if (clock < 10 * 60 || clock > 14 * 60 + 15 || s.today5.length < 8) return;
    funnel.evaluated += 1;
    for (const dir of [1, -1] as const) {
      const signal = evaluate(dir, t);
      if (signal && (s.pendingIndex !== index)) { s.pending = signal; s.pendingIndex = index; }
    }
  }

  function evaluate(dir: 1 | -1, t: number): Signal | null {
    const s = state;
    const atr = s.atr5 ?? 0;
    if (!(atr > 0)) return null;
    const bars = s.today5;
    const last = bars.at(-1)!;
    const prior = bars.at(-2)!;
    const key = dir > 0 ? "long" : "short";

    // 1) Regime.
    const recent6 = bars.slice(-6);
    const sideOfVwap = recent6.every((item) => (item.bar.close - item.vwap) * dir > 0);
    const vwapSlope = (last.vwap - bars[bars.length - 7].vwap) * dir > 0;
    const range = adr();
    const orBroken = Number.isFinite(s.orHigh) && bars.some((item) => istMinute(item.bar.time) >= 9 * 60 + 45 && (dir > 0 ? item.bar.close > s.orHigh : item.bar.close < s.orLow));
    const net = (last.bar.close - s.dayOpen) * dir;
    const progressed = Number.isFinite(range) && net >= 0.35 * range;
    let travel = Math.abs(bars[0].bar.close - s.dayOpen);
    for (let index = 1; index < bars.length; index += 1) travel += Math.abs(bars[index].bar.close - bars[index - 1].bar.close);
    const efficiency = travel > 0 ? net / travel : 0;
    const dayRange = s.dayHigh - s.dayLow;
    const nearExtreme = dayRange > 0 && (dir > 0 ? (last.bar.close - s.dayLow) / dayRange >= 0.55 : (s.dayHigh - last.bar.close) / dayRange >= 0.55);
    const htf = s.ema15 !== null && s.ema15History.length >= 3 && (s.close15 - s.ema15) * dir > 0 && (s.ema15 - s.ema15History[0]) * dir > 0;
    if (!(efficiency >= 0.3 && progressed && nearExtreme && sideOfVwap && vwapSlope && htf)) return null;
    funnel.trendBars += 1;

    // 2) Pullback into value within the last 3 bars, holding VWAP.
    const window = bars.slice(-3);
    const tagged = window.some((item) => (dir > 0 ? item.bar.low <= Math.max(item.vwap, item.ema) + 0.3 * atr : item.bar.high >= Math.min(item.vwap, item.ema) - 0.3 * atr));
    const held = window.every((item) => (item.bar.close - item.vwap) * dir > -0.2 * atr);
    if (!(tagged && held)) return null;
    // One entry per pullback: the previous signal must be older than this pullback window.
    if (s.lastSignalBar[key] >= bars.length - 3) return null;
    funnel.pullbacks += 1;

    // 3) Trigger: trend resumes on a strong candle.
    const c = last.bar;
    const p = prior.bar;
    const candleRange = Math.max(c.high - c.low, 1e-9);
    const strongClose = (c.close - c.open) * dir > 0 && (dir > 0 ? (c.close - c.low) / candleRange >= 0.6 : (c.high - c.close) / candleRange >= 0.6);
    const resumes = dir > 0 ? c.close > p.high : c.close < p.low;
    const engulfs = (p.close - p.open) * dir < 0 && (c.close - p.open) * dir >= 0 && (c.open - p.close) * dir <= 0;
    const aboveEma = (c.close - last.ema) * dir > 0;
    if (!(strongClose && (resumes || engulfs) && aboveEma)) return null;
    funnel.triggers += 1;
    if ((c.close - last.ema) * dir > 1.5 * atr) { funnel.extended += 1; return null; }

    // 4) Risk.
    const extreme = dir > 0 ? Math.min(...window.map((item) => item.bar.low)) : Math.max(...window.map((item) => item.bar.high));
    let stop = extreme - dir * 0.15 * atr;
    let risk = (c.close - stop) * dir;
    if (risk > 1.6 * atr) { funnel.tooWide += 1; return null; }
    if (risk < 0.6 * atr) { stop = c.close - dir * 0.6 * atr; risk = 0.6 * atr; }
    s.lastSignalBar[key] = bars.length - 1;

    // 5) Score the context (for the min-confidence filter and the trade log).
    const clock = istMinute(t);
    const reasons: string[] = [];
    let confidence = 60;
    reasons.push(`efficiency ${efficiency.toFixed(2)}, ${(net / range).toFixed(1)}× ADR from the open`);
    if (orBroken) { confidence += 4; reasons.push("opening range broken"); }
    if (efficiency >= 0.5) { confidence += 6; reasons.push("very clean trend"); }
    if (engulfs) { confidence += 5; reasons.push("engulfing resumption"); }
    if (window.some((item) => (dir > 0 ? item.bar.low <= item.vwap + 0.1 * atr : item.bar.high >= item.vwap - 0.1 * atr))) { confidence += 5; reasons.push("pullback tagged VWAP"); }
    if (clock <= 12 * 60) { confidence += 5; reasons.push("morning trend leg"); }
    else if (clock >= 13 * 60 + 30) { confidence -= 5; reasons.push("late-day entry (−)"); }
    const runDay = Number.isFinite(range) && (s.dayHigh - s.dayLow) > 1.3 * range;
    if (runDay) { confidence -= 5; reasons.push("day already > 1.3× ADR (−)"); }

    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      time: t, side: dir, stop: round(stop), target1: round(c.close + dir * 1.5 * risk), target2: round(c.close + dir * 4 * risk), confidence: Math.max(0, Math.min(100, confidence)), strategy: NAME,
      reason: `${dir > 0 ? "Buy CE" : "Buy PE"}: trend day (30 min ${dir > 0 ? "above" : "below"} a ${dir > 0 ? "rising" : "falling"} VWAP ${fmt(last.vwap)}, 15m EMA20 ${dir > 0 ? "rising" : "falling"}) → pullback to EMA20/VWAP → 5m ${engulfs ? "engulfing" : "strong close"} resumes the trend at ${fmt(c.close)}. ${reasons.join(", ")}.`,
    };
  }

  const source = (index: number): Signal | null => {
    if (index < state.next1 - 1) { state = fresh(); Object.assign(funnel, { evaluated: 0, trendBars: 0, pullbacks: 0, triggers: 0, tooWide: 0, extended: 0 }); }
    while (state.next1 <= index) {
      state.pending = null; state.pendingIndex = -1;
      on1m(state.next1);
      state.next1 += 1;
    }
    return state.pendingIndex === index ? state.pending : null;
  };
  return Object.assign(source, { funnel });
}
