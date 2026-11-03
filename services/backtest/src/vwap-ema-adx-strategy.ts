import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { istDay, type Signal } from "./strategy-backtest";
import { adxSeries } from "./indicators";

export { adxSeries };

/**
 * VWAP + 5/9 EMA + ADX scalper, replayed on 1-minute index bars for the backtester.
 *
 * The live scalper's tape rules (quant/.../algo_engine/scalp_strategy.py, read_tape and the ADX
 * criterion), bar for bar, on today's session only:
 *
 *   side      close above VWAP and 5 EMA above 9 EMA (long); the mirror for a short
 *   VWAP      close on the trade side, VWAP sloping that way over 5 bars, close no further than
 *             1.5 ATR(14, 1m) from VWAP (no chasing)
 *   EMA       5 EMA beyond 9 EMA beyond VWAP; a pullback within the last 3 bars tags the 9 EMA
 *             (± 0.05 ATR); the trigger candle closes beyond the 5 EMA and the prior candle's
 *             extreme, in the trade's direction, on at least 1.2x the prior 20 bars' volume
 *   ADX       Wilder ADX(14) on the trigger (confirmation) candle; the simulator applies the
 *             threshold (above 20 by default), so the optimizer can test others
 *   stop      beyond the pullback extreme or the 9 EMA, whichever is further, plus 0.15 ATR;
 *             widened to 0.3 ATR if tighter, refused if wider than 1.5 ATR
 *
 * The trigger may be the latest completed candle or the one before (price within 0.5 ATR of it and
 * still beyond the 5 EMA), as live; each trigger candle signals at most once.
 *
 * Not replayable historically, so not applied: the option-chain criteria (strike delta, OI writers,
 * PCR, the premium's own volume profile) and India VIX. Historical index candles carry no volume:
 * when a session has none, VWAP is time-weighted and the volume check is skipped (counted in the
 * funnel), where live trading would fail closed.
 */

export const VWAP_EMA_ADX = {
  emaFast: 5, emaSlow: 9, atrPeriod: 14, adxPeriod: 14, minSessionBars: 15, vwapSlopeBars: 5, maxVwapExtensionAtr: 1.5,
  pullbackBars: 3, emaTouchAtr: 0.05, minVolumeRatio: 1.2, volumeLookback: 20, triggerMaxAge: 1, maxDriftAtr: 0.5,
  stopBufferAtr: 0.15, minRiskAtr: 0.3, maxRiskAtr: 1.5,
} as const;

export type VwapEmaAdxFunnel = {
  evaluated: number; sided: number; stacked: number; triggers: number; adxUnavailable: number; vwapExtended: number; vwapFlat: number;
  lowVolume: number; volumeUnavailable: number; stopTooWide: number; signals: number;
};

/** The ADX reading carried on each signal; the simulator compares it with settings.adxMin. */
export type VwapEmaAdxSignal = Signal & { adx: number; plusDi: number; minusDi: number; management: "VWAP_EMA" };

type Session = {
  start: number; end: number; ema5: number[]; ema9: number[]; vwap: number[]; observable: boolean;
  adx: Array<[number, number, number] | null>;
};

function emaSeries(values: number[], period: number) {
  const out: number[] = [];
  const k = 2 / (period + 1);
  values.forEach((value, index) => out.push(index === 0 ? value : (value - out[index - 1]) * k + out[index - 1]));
  return out;
}

/** ATR as scalp_strategy.atr_value: the first bar's own range, then Wilder over the window. */
function atrValue(bars: Bar[], period: number) {
  if (bars.length < 2) return null;
  const ranges = bars.map((bar, index) => index === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close)));
  if (ranges.length < period) return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  let value = ranges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (const item of ranges.slice(period)) value = (value * (period - 1) + item) / period;
  return value;
}

export function vwapEmaAdxSignalSource(_symbol: string, minute: Bar[]) {
  const c = VWAP_EMA_ADX;
  const funnel: VwapEmaAdxFunnel = { evaluated: 0, sided: 0, stacked: 0, triggers: 0, adxUnavailable: 0, vwapExtended: 0, vwapFlat: 0, lowVolume: 0, volumeUnavailable: 0, stopTooWide: 0, signals: 0 };
  const sessions = new Map<string, Session>();
  const fired = new Set<number>(); // trigger bar indices that already signalled

  function sessionFor(index: number): Session {
    const day = istDay(minute[index].time);
    const cached = sessions.get(day);
    if (cached && index <= cached.end) return cached;
    let start = index;
    while (start > 0 && istDay(minute[start - 1].time) === day) start -= 1;
    let end = index;
    while (end + 1 < minute.length && istDay(minute[end + 1].time) === day) end += 1;
    const bars = minute.slice(start, end + 1);
    const closes = bars.map((bar) => bar.close);
    const observable = bars.some((bar) => (bar.volume ?? 0) > 0);
    const vwap: number[] = [];
    let pv = 0; let vol = 0;
    for (const bar of bars) {
      const weight = observable ? (bar.volume ?? 0) : 1;
      pv += (bar.high + bar.low + bar.close) / 3 * weight; vol += weight;
      vwap.push(vol > 0 ? pv / vol : bar.close);
    }
    // Every series is causal (each value uses only bars up to its own), so caching the whole day
    // never lets a decision see the future.
    const session: Session = { start, end, ema5: emaSeries(closes, c.emaFast), ema9: emaSeries(closes, c.emaSlow), vwap, observable, adx: adxSeries(bars, c.adxPeriod) };
    sessions.set(day, session);
    return session;
  }

  const signalAt = (index: number): VwapEmaAdxSignal | null => {
    const s = sessionFor(index);
    const last = index - s.start; // position of the decision bar in the session
    if (last + 1 < c.minSessionBars) return null;
    funnel.evaluated += 1;
    const bar = (k: number) => minute[s.start + k];
    const close = bar(last).close;
    const sessionBars = minute.slice(s.start, index + 1);
    const atr = atrValue(sessionBars.slice(-(c.atrPeriod * 3)), c.atrPeriod) ?? 0;
    const vwapNow = s.vwap[last];
    let side: 1 | -1;
    if (close > vwapNow && s.ema5[last] > s.ema9[last]) side = 1;
    else if (close < vwapNow && s.ema5[last] < s.ema9[last]) side = -1;
    else return null;
    funnel.sided += 1;
    const d = side;
    const stacked = (s.ema5[last] - s.ema9[last]) * d > 0 && (s.ema9[last] - vwapNow) * d > 0;
    if (!stacked) return null;
    funnel.stacked += 1;

    // Pullback-and-resume trigger on the latest completed candle, or the one before.
    let trigger: { k: number; extreme: number } | null = null;
    for (let age = 0; age <= c.triggerMaxAge; age += 1) {
      const k = last - age;
      if (k < c.pullbackBars + 1) break;
      const b = bar(k); const prev = bar(k - 1);
      const resumes = (b.close - s.ema5[k]) * d > 0 && (b.close - (d > 0 ? prev.high : prev.low)) * d > 0 && (b.close - b.open) * d > 0;
      let touched = false; let extreme = d > 0 ? Infinity : -Infinity;
      for (let j = k - c.pullbackBars; j <= k; j += 1) {
        const probe = d > 0 ? bar(j).low : bar(j).high;
        if ((probe - s.ema9[j]) * d <= atr * c.emaTouchAtr) touched = true;
        extreme = d > 0 ? Math.min(extreme, bar(j).low) : Math.max(extreme, bar(j).high);
      }
      if (resumes && touched) { trigger = { k, extreme }; break; }
    }
    if (trigger && trigger.k < last) {
      const drift = (close - bar(trigger.k).close) * d;
      if (drift > c.maxDriftAtr * atr || (close - s.ema5[last]) * d <= 0) trigger = null;
    }
    if (!trigger) return null;
    const triggerIndex = s.start + trigger.k;
    if (fired.has(triggerIndex)) return null;
    funnel.triggers += 1;

    const adx = s.adx[trigger.k];
    if (!adx) { funnel.adxUnavailable += 1; return null; }
    const slope = s.vwap.length > c.vwapSlopeBars && last >= c.vwapSlopeBars ? vwapNow - s.vwap[last - c.vwapSlopeBars] : 0;
    if (slope * d <= 0) { funnel.vwapFlat += 1; return null; }
    if (atr > 0 && Math.abs(close - vwapNow) / atr > c.maxVwapExtensionAtr) { funnel.vwapExtended += 1; return null; }
    let volumeNote = "";
    if (s.observable) {
      const prior = [];
      for (let j = Math.max(0, trigger.k - c.volumeLookback); j < trigger.k; j += 1) if ((bar(j).volume ?? 0) > 0) prior.push(bar(j).volume ?? 0);
      const own = bar(trigger.k).volume ?? 0;
      const ratio = own > 0 && prior.length >= 5 ? own / (prior.reduce((sum, value) => sum + value, 0) / prior.length) : null;
      if (ratio === null || ratio < c.minVolumeRatio) { funnel.lowVolume += 1; return null; }
      volumeNote = `, ${ratio.toFixed(1)}x volume`;
    } else funnel.volumeUnavailable += 1;

    const buffer = atr * c.stopBufferAtr;
    const level = d > 0 ? Math.min(trigger.extreme, s.ema9[last]) : Math.max(trigger.extreme, s.ema9[last]);
    let stop = level - buffer * d;
    let risk = (close - stop) * d;
    if (risk > 0 && risk < c.minRiskAtr * atr) { risk = c.minRiskAtr * atr; stop = close - risk * d; }
    if (!(risk > 0) || (atr > 0 && risk > c.maxRiskAtr * atr)) { funnel.stopTooWide += 1; return null; }

    fired.add(triggerIndex);
    funnel.signals += 1;
    const [adxValue, plusDi, minusDi] = adx;
    const at = new Date((bar(trigger.k).time + 330 * 60) * 1000).toISOString().slice(11, 16);
    return {
      time: minute[index].time + 60, side, stop: Math.round(stop * 100) / 100, // decided at the bar's close
      // The simulator re-derives the target from the fill (fill ± k·R, k = settings.scalpRiskReward),
      // as the live scalper does; this is the 1:2 plan at the signal close.
      target1: Math.round((close + 2 * risk * d) * 100) / 100, target2: null,
      confidence: 100, strategy: "VWAP-EMA-ADX scalp", management: "VWAP_EMA",
      adx: Math.round(adxValue * 100) / 100, plusDi: Math.round(plusDi * 100) / 100, minusDi: Math.round(minusDi * 100) / 100,
      reason: `${d > 0 ? "Long" : "Short"}: pullback to the 9 EMA resumed at ${at}${volumeNote}, ADX ${adxValue.toFixed(1)} (+DI ${plusDi.toFixed(1)} / −DI ${minusDi.toFixed(1)}), stop ${risk.toFixed(1)} pts (${atr > 0 ? (risk / atr).toFixed(2) : "--"} ATR)`,
    };
  };
  return Object.assign(signalAt, { funnel });
}
