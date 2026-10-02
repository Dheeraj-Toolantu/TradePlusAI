import type { Bar } from "../../services/ai-monitoring/src/mtf-decision-engine";

/** 11:00 IST on a Wednesday. */
export const MTF_NOW = new Date("2026-09-30T05:30:00Z");
const nowS = MTF_NOW.getTime() / 1000;

/** Deterministic trending series with shallow pullbacks; drift is points per bar. */
function trend(count: number, stepS: number, start: number, drift: number, swing: number, endS: number): Bar[] {
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const wave = Math.sin(i / 2.2) * swing;
    const open = price;
    const close = price + drift + wave * 0.35;
    const high = Math.max(open, close) + swing * 0.25;
    const low = Math.min(open, close) - swing * 0.25;
    bars.push({ time: endS - (count - i) * stepS, open, high, low, close, volume: 1000 });
    price = close;
  }
  return bars;
}

/** Bullish multi-timeframe stack ending with a 5m pullback and a 1m bullish engulfing. */
export function bullishStack(direction: 1 | -1 = 1) {
  const d = direction;
  const day = 86_400;
  const daily = trend(60, day, 24000 - d * 1500, d * 25, 60, nowS - 6 * 3600); // completed days only
  const m15 = trend(80, 900, 24600 - d * 300, d * 4, 10, nowS);
  const m5 = trend(90, 300, 24900 - d * 200, d * 2.2, 6, nowS);
  // 5m pullback: last three 5m bars drift back toward the EMA20.
  for (const bar of m5.slice(-3)) { bar.open -= d * 6; bar.close -= d * 8; bar.high -= d * 6; bar.low -= d * 9; }
  // Price has pulled back to roughly the 5m 20-bar mean (value), where the 1m trigger prints.
  const value = m5.slice(-20).reduce((sum, bar) => sum + bar.close, 0) / 20;
  const m1 = trend(40, 60, value - d * 14, d * 0.3, 1.2, nowS);
  // Last two 1m candles: a small counter candle, then an engulfing candle in the trend direction.
  const prev = m1.at(-2)!;
  const last = m1.at(-1)!;
  prev.open = prev.close + d * 1.5; prev.high = Math.max(prev.open, prev.close) + 0.3; prev.low = Math.min(prev.open, prev.close) - 0.3;
  last.open = prev.close - d * 0.2; last.close = prev.open + d * 2.5;
  last.high = Math.max(last.open, last.close) + 0.2; last.low = Math.min(last.open, last.close) - 0.2;
  last.volume = 2500;
  return { "1D": daily, "15m": m15, "5m": m5, "1m": m1, spot: last.close };
}
