import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { aggregate, istDay, type Signal } from "./strategy-backtest";
import { adxSeries } from "./indicators";

/**
 * "VWAP–EMA–ADX Intraday Strategy", Implementation Specification v1.0 (03 November 2026).
 *
 * Signals on completed signal-timeframe candles (5-minute baseline; 1 and 3 selectable):
 *
 *   BUY CE (+1)  Close > VWAP, EMA9 > EMA21, ADX14 > threshold, +DI > −DI, Close > High[t−1]
 *   BUY PE (−1)  Close < VWAP, EMA9 < EMA21, ADX14 > threshold, −DI > +DI, Close < Low[t−1]
 *
 * Indicators (section 4):
 *   - VWAP: session-anchored, typical price × volume; undefined (no signal) while the session's
 *     cumulative volume is zero. "TIME_WEIGHTED" is an explicit, labelled deviation for index
 *     history that carries no volume.
 *   - EMA: alpha = 2 / (period + 1), seeded with the simple average of the first `period` closes
 *     (valid from bar period − 1), continuous across sessions.
 *   - ADX / +DI / −DI: Wilder's smoothing (adxSeries), valid from bar 2 × 14 − 1, continuous across
 *     sessions. Warm-up candles come from the days the loader adds before the tested range.
 *
 * Execution and risk (sections 7–9) live in the simulator (management "FIXED_POINTS"): entry at
 * the next candle's open, SL / target a fixed number of index points from that open, SL first when
 * one candle touches both, square-off at the configured time, optional EMA9/EMA21 opposite-cross
 * exit, one position at a time, daily trade and loss limits. The ADX threshold is applied there too
 * (strictly greater), so sensitivity tests can vary it without recomputing signals.
 *
 * A candle counts as complete only when the wall clock has passed its end (the 1-minute bar ending
 * at the bucket's end has closed); a bucket whose last minute is missing is skipped and counted,
 * never inferred from the next bar (no look-ahead).
 */

export const SPEC_STRATEGY_VERSION = "VWAP–EMA–ADX Intraday Strategy v1.0 (spec dated 03 Nov 2026)";
export const SPEC_PARAMS = { emaFast: 9, emaSlow: 21, adxPeriod: 14 } as const;

export type SpecTimeframe = 1 | 3 | 5;
export type SpecVwapMode = "STRICT" | "TIME_WEIGHTED";
export type SpecOptions = { timeframe: SpecTimeframe; vwapMode: SpecVwapMode };

export type SpecFunnel = {
  candles: number; warmup: number; incomplete: number; noVolume: number;
  bullishSetups: number; bearishSetups: number; failVwap: number; failEma: number; failDi: number; failBreakout: number;
  signals: number;
};

/** One evaluated candle that produced a signal, with its point-in-time indicator values. */
export type SpecSignalLog = {
  time: number; side: 1 | -1; close: number; vwap: number; ema9: number; ema21: number; adx: number; plusDi: number; minusDi: number; prevHigh: number; prevLow: number;
};

export type SpecSignal = Signal & { management: "FIXED_POINTS"; adx: number; plusDi: number; minusDi: number; exitCheck: (index: number) => boolean };

/** EMA with alpha 2/(n+1), seeded with the SMA of the first n values; NaN before that. */
export function emaSma(values: number[], period: number): number[] {
  const out = values.map(() => NaN);
  if (values.length < period) return out;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  out[period - 1] = value;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) { value = (values[i] - value) * k + value; out[i] = value; }
  return out;
}

/** Session VWAP per bar; NaN while the session has no volume (STRICT). */
export function sessionVwap(bars: Bar[], mode: SpecVwapMode): number[] {
  let day = ""; let pv = 0; let v = 0; let tp = 0; let n = 0;
  return bars.map((bar) => {
    const d = istDay(bar.time);
    if (d !== day) { day = d; pv = 0; v = 0; tp = 0; n = 0; }
    const typical = (bar.high + bar.low + bar.close) / 3;
    const volume = bar.volume ?? 0;
    pv += typical * volume; v += volume; tp += typical; n += 1;
    if (v > 0) return pv / v;
    return mode === "TIME_WEIGHTED" ? tp / n : NaN;
  });
}

/**
 * Pure signal rule (section 6) on one completed candle: +1, −1 or 0. Exposed for tests; the ADX
 * threshold is a parameter here (the backtest applies it in the simulator).
 */
export function specSignal(c: { close: number; vwap: number; ema9: number; ema21: number; adx: number; plusDi: number; minusDi: number; prevHigh: number; prevLow: number }, adxThreshold: number): 1 | -1 | 0 {
  if (![c.close, c.vwap, c.ema9, c.ema21, c.adx, c.plusDi, c.minusDi, c.prevHigh, c.prevLow].every(Number.isFinite)) return 0;
  if (c.close > c.vwap && c.ema9 > c.ema21 && c.adx > adxThreshold && c.plusDi > c.minusDi && c.close > c.prevHigh) return 1;
  if (c.close < c.vwap && c.ema9 < c.ema21 && c.adx > adxThreshold && c.minusDi > c.plusDi && c.close < c.prevLow) return -1;
  return 0;
}

export function vwapEmaAdxSpecSignalSource(_symbol: string, minute: Bar[], options: SpecOptions) {
  const tf = options.timeframe;
  const size = tf * 60;
  const bars = aggregate(minute, tf);
  const closes = bars.map((bar) => bar.close);
  const ema9 = emaSma(closes, SPEC_PARAMS.emaFast);
  const ema21 = emaSma(closes, SPEC_PARAMS.emaSlow);
  const adx = adxSeries(bars, SPEC_PARAMS.adxPeriod);
  const vwap = sessionVwap(bars, options.vwapMode);
  const byStart = new Map(bars.map((bar, index) => [bar.time, index]));
  const funnel: SpecFunnel = { candles: 0, warmup: 0, incomplete: 0, noVolume: 0, bullishSetups: 0, bearishSetups: 0, failVwap: 0, failEma: 0, failDi: 0, failBreakout: 0, signals: 0 };
  const log: SpecSignalLog[] = [];

  /** The signal candle that the 1-minute bar at `index` completes, if it completes one. */
  const completed = (index: number): number | null => {
    const bucket = Math.floor(minute[index].time / size) * size;
    if (minute[index].time + 60 < bucket + size) return null; // the candle is still forming
    return byStart.get(bucket) ?? null;
  };

  /** Opposite EMA9/EMA21 crossover on the candle completed at `index` (optional exit variant). */
  const crossedAgainst = (index: number, side: 1 | -1) => {
    const b = completed(index);
    if (b === null || b < 1 || !Number.isFinite(ema9[b]) || !Number.isFinite(ema9[b - 1])) return false;
    const now = (ema9[b] - ema21[b]) * side;
    const before = (ema9[b - 1] - ema21[b - 1]) * side;
    return now < 0 && before >= 0;
  };

  const signalAt = (index: number): SpecSignal | null => {
    const b = completed(index);
    if (b === null) {
      // The bucket's last minute is missing: count it once, at the bar that would have closed it.
      const next = minute[index + 1];
      const bucket = Math.floor(minute[index].time / size) * size;
      if (tf > 1 && (!next || Math.floor(next.time / size) * size !== bucket)) funnel.incomplete += 1;
      return null;
    }
    funnel.candles += 1;
    const a = adx[b];
    if (b < 1 || !a || !Number.isFinite(ema21[b]) || !Number.isFinite(ema9[b])) { funnel.warmup += 1; return null; }
    if (!Number.isFinite(vwap[b])) { funnel.noVolume += 1; return null; }
    const [adxValue, plusDi, minusDi] = a;
    const c = { close: bars[b].close, vwap: vwap[b], ema9: ema9[b], ema21: ema21[b], adx: adxValue, plusDi, minusDi, prevHigh: bars[b - 1].high, prevLow: bars[b - 1].low };
    // Direction first from VWAP; record which rule failed (the ADX threshold is applied per trade).
    const side: 1 | -1 = c.close >= c.vwap ? 1 : -1;
    if (side > 0) funnel.bullishSetups += 1; else funnel.bearishSetups += 1;
    const signal = specSignal(c, -Infinity);
    if (signal === 0) {
      if ((c.close - c.vwap) * side <= 0) funnel.failVwap += 1;
      else if ((c.ema9 - c.ema21) * side <= 0) funnel.failEma += 1;
      else if ((side > 0 ? plusDi - minusDi : minusDi - plusDi) <= 0) funnel.failDi += 1;
      else funnel.failBreakout += 1;
      return null;
    }
    funnel.signals += 1;
    if (log.length < 5000) log.push({ time: bars[b].time, side: signal, ...c });
    const label = signal > 0 ? "BUY CE (bullish)" : "BUY PE (bearish)";
    const at = new Date((bars[b].time + size + 330 * 60) * 1000).toISOString().slice(11, 16);
    return {
      time: minute[index].time + 60, side: signal, management: "FIXED_POINTS", // decided at the candle's close
      // Placeholders: the simulator sets SL / target from the next candle's open (section 8).
      stop: c.close - signal * 20, target1: c.close + signal * 40, target2: null,
      confidence: 100, strategy: "VWAP-EMA-ADX spec v1.0", adx: Math.round(adxValue * 100) / 100, plusDi: Math.round(plusDi * 100) / 100, minusDi: Math.round(minusDi * 100) / 100,
      exitCheck: (j: number) => crossedAgainst(j, signal),
      reason: `${label} on the ${tf}m candle closing ${at}: close ${c.close.toFixed(2)} ${signal > 0 ? ">" : "<"} VWAP ${c.vwap.toFixed(2)}, EMA9 ${c.ema9.toFixed(2)} ${signal > 0 ? ">" : "<"} EMA21 ${c.ema21.toFixed(2)}, ADX ${adxValue.toFixed(1)} (+DI ${plusDi.toFixed(1)} / −DI ${minusDi.toFixed(1)}), ${signal > 0 ? `close > previous high ${c.prevHigh.toFixed(2)}` : `close < previous low ${c.prevLow.toFixed(2)}`}`,
    };
  };
  return Object.assign(signalAt, { funnel, log });
}
