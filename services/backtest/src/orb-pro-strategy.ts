import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { aggregate, istDay, istMinute, type Signal } from "./strategy-backtest";

/**
 * ORB retest — Pro. The opening-range breakout as an experienced index trader actually trades it.
 *
 * SENTIMENT FIRST (before the open is even done)
 *  - Gap: an open beyond yesterday's high/low, or more than 0.4× the average daily range (ADR) from
 *    yesterday's close, is a gap day. By default gap days are NOT traded: on real NIFTY 1-minute data
 *    (2024–2026) ORB retests after a gap lost in both directions — the first hour is overnight orders
 *    being filled and gaps tend to fill. (With gapDays BONUS/PENALTY they use a 30-minute range.)
 *  - Yesterday's close location (top/bottom 30% of its range) tells who finished in control.
 *  - An opening range wider than 0.6 ADR has already spent most of the day's move: no trade.
 *
 * THE BREAKOUT MUST SHOW CONVICTION
 *  - A 5-minute candle CLOSES beyond the range by ≥ 0.1 ATR, with a real body (≥ 50% of its range),
 *    closing in its outer 30%, and expanding (range ≥ 0.8× the last six candles' average). A wick
 *    poke is how breakout traders get trapped, not a breakout.
 *  - Breakouts are taken until 11:30; the ORB edge fades as the morning ends.
 *  - If one side already broke and FAILED (closed back inside), those breakout traders are trapped:
 *    a clean break of the other side is the stronger trade.
 *
 * THE RETEST IS THE ENTRY (never chase the breakout candle)
 *  - Within 30 minutes price comes back to the broken level (within 0.25 ATR): late longs are
 *    shaken out and the breakout buyers defend their level.
 *  - The retest must HOLD: no 5-minute close back inside the range (beyond 0.15 ATR) and no wick
 *    past the range's midpoint (that is a failed breakout, not a retest).
 *  - Acceptance: at least one more 5-minute close beyond the level after the breakout candle. On a
 *    rotation day the break is rejected straight back inside.
 *  - Directional session: the move from the open, divided by the distance travelled (5m closes), must
 *    be ≥ 0.30 in the trade's direction. Chop goes nowhere with a lot of travel, and that is where
 *    ORB traders get chopped up.
 *  - Trigger on a 1-minute candle that turns with the trend from the retest: closes back beyond the
 *    level, in its outer half, above (below) the prior candle's high (low) or engulfing it — and price
 *    must be on the right side of VWAP (buyers in control for longs).
 *
 * THE STOP — placed where the idea is wrong, not where it is comfortable
 *  1. Structural: beyond the retest's extreme AND beyond the breakout level (whichever is further),
 *     plus a buffer of max(0.15 ATR, 0.03% of price). The level itself is where everybody's stop sits
 *     and where it gets hunted; the retest low is what the defenders actually held.
 *  2. Round numbers: if a round number (NIFTY 50s, BANKNIFTY/SENSEX 100s) sits within 0.25 ATR beyond
 *     that stop, the stop goes beyond the round number — stop runs love round numbers.
 *  3. Noise floor: never closer than 0.5 ATR(5m) to entry; ordinary 5-minute noise would take it.
 *  4. Hard cap: if the honest stop is wider than 1.3 ATR or 0.45% of price, the trade is skipped —
 *     a stop is never tightened just to make the size fit.
 *
 * TARGETS
 *  - T1: the measured move (breakout level + opening-range width), kept between 1R and 1.5R.
 *  - T2: two range-widths, capped by yesterday's high (low) if it is in the way, and by 4R.
 *  - No trade if yesterday's high (low) is less than 1R away — no room to work.
 */

const NAME = "ORB retest Pro";
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
const round2 = (value: number) => Math.round(value * 100) / 100;

export type OrbProFunnel = {
  days: number; gapDays: number; orTooWide: number; breakouts: number; weakBreakouts: number; failedBreakouts: number;
  retests: number; deepRetests: number; expired: number; triggers: number; stopTooWide: number; noRoom: number; againstVwap: number;
  notAccepted: number; choppy: number;
};
const emptyFunnel = (): OrbProFunnel => ({ days: 0, gapDays: 0, orTooWide: 0, breakouts: 0, weakBreakouts: 0, failedBreakouts: 0, retests: 0, deepRetests: 0, expired: 0, triggers: 0, stopTooWide: 0, noRoom: 0, againstVwap: 0, notAccepted: 0, choppy: 0 });

type Breakout = { dir: 1 | -1; level: number; k: number; time: number; extreme: number; touched: boolean; lastTouch: number; afterFailure: boolean; quality: number; closesBeyond: number };

/** Tunable rules (defaults are the validated ones; the alternatives exist for walk-forward checks). */
export type OrbProOptions = { t1: "MEASURED" | "ONE_R"; gapDays: "BONUS" | "PENALTY" | "SKIP" };
// Validated on real NIFTY 1-minute data (Jan 2024 – Oct 2026): chosen on 2024–25, confirmed on 2026.
// Gap days are skipped: ORB retests on gap days lost money in both directions (overnight orders make
// the first hour a two-sided auction, and gaps tend to fill).
export const ORB_PRO_DEFAULTS: OrbProOptions = { t1: "MEASURED", gapDays: "SKIP" };

export function orbProSignalSource(symbol: string, minute: Bar[], daily: Bar[], overrides: Partial<OrbProOptions> = {}) {
  const options: OrbProOptions = { ...ORB_PRO_DEFAULTS, ...overrides };
  const m5 = aggregate(minute, 5);
  const roundStep = symbol === "NIFTY" ? 50 : 100;
  const funnel = emptyFunnel();
  let state = fresh();

  function fresh() {
    return {
      next1: 0, next5: 0,
      day: "", ranges: [] as number[],
      prevHigh: NaN, prevLow: NaN, prevClose: NaN, prevCloseLocation: 0.5,
      sessionHigh: -Infinity, sessionLow: Infinity, lastClose: NaN,
      dayOpen: NaN, travel: 0, lastFive: NaN, gapDay: false, gapDir: 0 as -1 | 0 | 1, orMinutes: 15,
      orHigh: -Infinity, orLow: Infinity, orReady: false, disabled: false,
      pv: 0, v: 0, tpSum: 0, n: 0, vwap: NaN,
      atr5: null as number | null,
      breakout: null as Breakout | null,
      failedDir: 0 as -1 | 0 | 1,
      done: { long: false, short: false },
      pending: null as Signal | null, pendingIndex: -1,
    };
  }

  function adr() {
    const s = state;
    const dayStart = Date.parse(`${s.day}T00:00:00Z`) / 1000 - 330 * 60;
    const fromDaily = daily.filter((bar) => bar.time < dayStart && istDay(bar.time) < s.day).slice(-10).map((bar) => bar.high - bar.low);
    const ranges = [...fromDaily.slice(0, Math.max(0, 10 - s.ranges.length)), ...s.ranges].filter((range) => range > 0);
    return ranges.length >= 3 ? ranges.reduce((sum, range) => sum + range, 0) / ranges.length : NaN;
  }

  function startDay(day: string, open: number) {
    const s = state;
    const fromMinutes = s.day !== "" && Number.isFinite(s.sessionHigh);
    if (fromMinutes) {
      s.ranges = [...s.ranges, s.sessionHigh - s.sessionLow].slice(-10);
      s.prevHigh = s.sessionHigh; s.prevLow = s.sessionLow; s.prevClose = s.lastClose;
    } else {
      const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000 - 330 * 60;
      const prior = [...daily].reverse().find((bar) => bar.time < dayStart && istDay(bar.time) < day);
      s.prevHigh = prior?.high ?? NaN; s.prevLow = prior?.low ?? NaN; s.prevClose = prior?.close ?? NaN;
    }
    s.prevCloseLocation = s.prevHigh > s.prevLow ? (s.prevClose - s.prevLow) / (s.prevHigh - s.prevLow) : 0.5;
    s.day = day; s.dayOpen = open; s.travel = 0; s.lastFive = open;
    s.sessionHigh = -Infinity; s.sessionLow = Infinity;
    s.pv = 0; s.v = 0; s.tpSum = 0; s.n = 0; s.vwap = NaN;
    s.orHigh = -Infinity; s.orLow = Infinity; s.orReady = false; s.disabled = false;
    s.breakout = null; s.failedDir = 0; s.done = { long: false, short: false };
    funnel.days += 1;
    const range = adr();
    const gap = Number.isFinite(s.prevClose) ? open - s.prevClose : 0;
    s.gapDay = Number.isFinite(s.prevHigh) && (open > s.prevHigh || open < s.prevLow || (Number.isFinite(range) && Math.abs(gap) > 0.4 * range));
    s.gapDir = s.gapDay ? (gap > 0 ? 1 : -1) : 0;
    s.orMinutes = s.gapDay ? 30 : 15;
    if (s.gapDay) funnel.gapDays += 1;
  }

  function on1m(index: number) {
    const s = state;
    const bar = minute[index];
    const day = istDay(bar.time);
    if (day !== s.day) startDay(day, bar.open);
    s.sessionHigh = Math.max(s.sessionHigh, bar.high); s.sessionLow = Math.min(s.sessionLow, bar.low); s.lastClose = bar.close;
    const typical = (bar.high + bar.low + bar.close) / 3;
    s.pv += typical * (bar.volume ?? 0); s.v += bar.volume ?? 0; s.tpSum += typical; s.n += 1;
    s.vwap = s.v > 0 ? s.pv / s.v : s.tpSum / s.n;
    const clock = istMinute(bar.time);
    const orEnd = 9 * 60 + 15 + s.orMinutes;
    if (clock < orEnd) { s.orHigh = Math.max(s.orHigh, bar.high); s.orLow = Math.min(s.orLow, bar.low); }
    else if (!s.orReady && Number.isFinite(s.orHigh)) {
      s.orReady = true;
      const range = adr();
      if (Number.isFinite(range) && s.orHigh - s.orLow > 0.6 * range) { s.disabled = true; funnel.orTooWide += 1; }
    }
    const t = bar.time + 60;
    while (state.next5 < m5.length && m5[state.next5].time + 300 <= t) on5m(state.next5++);
    trigger(index);
  }

  function on5m(k: number) {
    const s = state;
    const bar = m5[k];
    const prev = m5[k - 1];
    const firstOfDay = !prev || istDay(prev.time) !== istDay(bar.time);
    const tr = firstOfDay ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
    s.atr5 = s.atr5 === null ? tr : (s.atr5 * 13 + tr) / 14;
    if (istDay(bar.time) === s.day) { s.travel += Math.abs(bar.close - s.lastFive); s.lastFive = bar.close; }
    if (istDay(bar.time) !== s.day || !s.orReady || s.disabled) return;
    const atr = s.atr5;
    const close = istMinute(bar.time + 300);
    const mid = (s.orHigh + s.orLow) / 2;
    const b = s.breakout;

    if (b) {
      const d = b.dir;
      // Failure: a 5m close back inside the range.
      if ((bar.close - (b.level - d * 0.15 * atr)) * d < 0) { funnel.failedBreakouts += 1; s.failedDir = d; s.breakout = null; return; }
      // Too deep: the retest went through half the range.
      if ((d > 0 ? bar.low < mid : bar.high > mid)) { funnel.deepRetests += 1; s.breakout = null; return; }
      b.extreme = d > 0 ? Math.min(b.extreme, bar.low) : Math.max(b.extreme, bar.high);
      if ((bar.close - b.level) * d > 0) b.closesBeyond += 1;
      if (k - b.k > 6 && !b.touched) { funnel.expired += 1; s.breakout = null; return; }
      if (b.touched && k - b.k > 9) { funnel.expired += 1; s.breakout = null; }
      return;
    }

    if (close > 11 * 60 + 30) return;
    const range = Math.max(bar.high - bar.low, 1e-9);
    const recent = m5.slice(Math.max(0, k - 6), k).filter((other) => istDay(other.time) === s.day);
    const avgRange = recent.length ? recent.reduce((sum, other) => sum + other.high - other.low, 0) / recent.length : range;
    for (const dir of [1, -1] as const) {
      if (dir > 0 ? s.done.long : s.done.short) continue;
      const level = dir > 0 ? s.orHigh : s.orLow;
      if ((bar.close - level) * dir <= 0) continue;
      const strongBody = Math.abs(bar.close - bar.open) / range >= 0.5 && (bar.close - bar.open) * dir > 0;
      const outerClose = dir > 0 ? (bar.close - bar.low) / range >= 0.7 : (bar.high - bar.close) / range >= 0.7;
      const clearance = (bar.close - level) * dir >= 0.1 * atr;
      const expansion = range >= 0.8 * avgRange;
      if (!(strongBody && outerClose && clearance && expansion)) { funnel.weakBreakouts += 1; continue; }
      funnel.breakouts += 1;
      // The retest extreme starts at the breakout close: the breakout candle's own low (it opened
      // inside the range) is not part of the retest and would only widen the stop.
      s.breakout = { dir, level, k, time: bar.time + 300, extreme: bar.close, touched: false, lastTouch: 0, afterFailure: s.failedDir === -dir, quality: range / Math.max(avgRange, 1e-9), closesBeyond: 1 };
      break;
    }
  }

  function trigger(index: number) {
    const s = state;
    const b = s.breakout;
    if (!b || s.atr5 === null) return;
    const bar = minute[index];
    const t = bar.time + 60;
    if (bar.time < b.time) return; // still inside the breakout candle
    const d = b.dir;
    const atr = s.atr5;
    b.extreme = d > 0 ? Math.min(b.extreme, bar.low) : Math.max(b.extreme, bar.high);
    const inZone = d > 0 ? bar.low <= b.level + 0.25 * atr : bar.high >= b.level - 0.25 * atr;
    if (inZone) { if (!b.touched) funnel.retests += 1; b.touched = true; b.lastTouch = t; }
    if (!b.touched || t - b.lastTouch > 10 * 60 || istMinute(t) > 12 * 60) return;
    const prev = minute[index - 1];
    const candleRange = Math.max(bar.high - bar.low, 1e-9);
    const turns = (bar.close - bar.open) * d > 0 && (d > 0 ? (bar.close - bar.low) / candleRange >= 0.5 : (bar.high - bar.close) / candleRange >= 0.5);
    const beyondLevel = (bar.close - b.level) * d > 0;
    const resumes = Boolean(prev) && (d > 0 ? bar.close > prev.high : bar.close < prev.low);
    const engulfs = Boolean(prev) && (prev.close - prev.open) * d < 0 && (bar.close - prev.open) * d >= 0 && (bar.open - prev.close) * d <= 0;
    if (!(turns && beyondLevel && (resumes || engulfs))) return;
    if ((bar.close - b.level) * d > 0.8 * atr) return; // left the retest zone: do not chase
    if (Number.isFinite(s.vwap) && (bar.close - s.vwap) * d < 0) { funnel.againstVwap += 1; return; }
    // Acceptance: the market must have closed beyond the level again after the breakout candle —
    // in a rotation day the break is rejected straight back inside.
    if (b.closesBeyond < 2) { funnel.notAccepted += 1; return; }
    // Directional session: net move from the open vs the distance travelled (5m closes) ≥ 0.30, in
    // the trade's direction. Chop goes nowhere with a lot of travel.
    const net = (bar.close - s.dayOpen) * d;
    const efficiency = s.travel > 0 ? net / (s.travel + Math.abs(bar.close - s.lastFive)) : 0;
    if (efficiency < 0.3) { funnel.choppy += 1; return; }
    funnel.triggers += 1;

    // ---- The stop -------------------------------------------------------------------------------
    const entry = bar.close;
    const buffer = Math.max(0.15 * atr, entry * 0.0003);
    const structural = d > 0 ? Math.min(b.extreme, b.level) : Math.max(b.extreme, b.level);
    let stop = structural - d * buffer;
    const notes: string[] = [`beyond the retest ${d > 0 ? "low" : "high"} ${fmt(b.extreme)} and the ${d > 0 ? "OR high" : "OR low"} ${fmt(b.level)} + ${fmt(buffer)} buffer`];
    const round = d > 0 ? Math.floor(stop / roundStep) * roundStep : Math.ceil(stop / roundStep) * roundStep;
    if (Math.abs(stop - round) <= 0.25 * atr) { stop = round - d * 0.1 * atr; notes.push(`moved past the ${round} round number (stop-hunt magnet)`); }
    let risk = (entry - stop) * d;
    if (risk < 0.5 * atr) { stop = entry - d * 0.5 * atr; risk = 0.5 * atr; notes.push("widened to the 0.5 ATR noise floor"); }
    if (risk > 1.3 * atr || risk > entry * 0.0045) { funnel.stopTooWide += 1; s.breakout = null; return; }

    // ---- Targets and room -------------------------------------------------------------------------
    const width = s.orHigh - s.orLow;
    const measured = (b.level + d * width - entry) * d;
    const t1Distance = options.t1 === "ONE_R" ? risk : Math.min(1.5 * risk, Math.max(risk, measured));
    const obstacle = d > 0 ? s.prevHigh : s.prevLow;
    const room = Number.isFinite(obstacle) && (obstacle - entry) * d > 0 ? (obstacle - entry) * d : Infinity;
    if (room < risk) { funnel.noRoom += 1; s.breakout = null; return; }
    let t2Distance = Math.min(4 * risk, (b.level + d * 2 * width - entry) * d);
    if (room < t2Distance && room > t1Distance) t2Distance = room - 0.05 * risk;
    t2Distance = Math.max(t2Distance, t1Distance + 0.5 * risk);

    // ---- Conviction score -------------------------------------------------------------------------
    const reasons: string[] = [];
    let confidence = 55;
    if (s.gapDay && options.gapDays === "SKIP") { s.breakout = null; return; }
    if (s.gapDay && options.gapDays === "PENALTY") { confidence -= 8; reasons.push("gap day: overnight orders, two-sided early auction (−)"); }
    else if (s.gapDay && s.gapDir === d) { confidence += 10; reasons.push("gap-and-go in the gap's direction"); }
    else if (s.gapDay && s.gapDir === -d) { confidence -= 8; reasons.push("against the gap (gap-fill) (−)"); }
    if (b.afterFailure) { confidence += 8; reasons.push("opposite breakout failed first: those traders are trapped"); }
    if (d > 0 ? s.prevCloseLocation >= 0.7 : s.prevCloseLocation <= 0.3) { confidence += 6; reasons.push(`yesterday closed near its ${d > 0 ? "high" : "low"}`); }
    const averageRange = adr();
    if (Number.isFinite(averageRange) && width < 0.25 * averageRange) { confidence += 5; reasons.push("tight, coiled opening range"); }
    if ((b.extreme - b.level) * d >= -0.1 * atr) { confidence += 5; reasons.push("retest held right at the level"); }
    if (b.quality >= 1.3) { confidence += 4; reasons.push("strong expansion on the breakout"); }
    if (engulfs) { confidence += 4; reasons.push("1m engulfing"); }
    if (istMinute(b.time) > 10 * 60 + 45) { confidence -= 8; reasons.push("late breakout (−)"); }
    confidence = Math.max(0, Math.min(100, confidence));

    if (d > 0) s.done.long = true; else s.done.short = true;
    s.breakout = null;
    const signal: Signal = {
      time: t, side: d, stop: round2(stop), target1: round2(entry + d * t1Distance), target2: round2(entry + d * t2Distance), confidence, strategy: NAME,
      reason: `${d > 0 ? "Buy CE" : "Buy PE"}: ${s.orMinutes}-min OR ${fmt(s.orLow)}–${fmt(s.orHigh)}${s.gapDay ? " (gap day)" : ""} → ${d > 0 ? "breakout" : "breakdown"} with conviction → retest of ${fmt(b.level)} held → 1m ${engulfs ? "engulfing" : "turn"} at ${fmt(entry)}. SL ${fmt(stop)} (${fmt(risk)} pts): ${notes.join("; ")}.${reasons.length ? ` Context: ${reasons.join(", ")}.` : ""}`,
    };
    if (s.pendingIndex !== index) { s.pending = signal; s.pendingIndex = index; }
  }

  const source = (index: number): Signal | null => {
    if (index < state.next1 - 1) { state = fresh(); Object.assign(funnel, emptyFunnel()); }
    while (state.next1 <= index) {
      state.pending = null; state.pendingIndex = -1;
      on1m(state.next1);
      state.next1 += 1;
    }
    return state.pendingIndex === index ? state.pending : null;
  };
  return Object.assign(source, { funnel });
}
