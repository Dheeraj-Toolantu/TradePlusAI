/**
 * Chart "technical plan": EMA 9/21 trend + confirmed candle pattern, with support/resistance
 * from recent price and option-chain OI, an ATR-floored stop and a structural target.
 * Kept out of app/page.tsx because a Next.js page may only export the page component.
 */

export type Candle = { open: number; high: number; low: number; close: number; volume: number; timestamp: string };
export type OptionContext = { support?: number; resistance?: number; supportStrike?: number; resistanceStrike?: number; callLtp?: number; putLtp?: number; source: string };

export function emaValues(values: number[], period: number) { const multiplier = 2 / (period + 1); let previous = values[0]; return values.map((value, index) => { previous = index === 0 ? value : (value - previous) * multiplier + previous; return index + 1 < period ? null : previous; }); }

export function candlePattern(current: Candle, previous: Candle) {
  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, 0.0001);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const doji = body / range <= 0.1;
  const bullishEngulfing = current.close > current.open && previous.close < previous.open && current.open <= previous.close && current.close >= previous.open;
  const bearishEngulfing = current.close < current.open && previous.close > previous.open && current.open >= previous.close && current.close <= previous.open;
  const hammer = lowerWick >= body * 2 && upperWick <= Math.max(body, range * 0.12) && current.close >= current.open;
  const shootingStar = upperWick >= body * 2 && lowerWick <= Math.max(body, range * 0.12) && current.close <= current.open;
  const insideBar = current.high <= previous.high && current.low >= previous.low;
  if (bullishEngulfing) return { name: "Bullish engulfing", signal: "BULLISH CONFIRMATION", confirmed: true };
  if (bearishEngulfing) return { name: "Bearish engulfing", signal: "BEARISH / SHORT CONFIRMATION", confirmed: true };
  if (hammer) return { name: "Hammer", signal: "BULLISH REVERSAL WATCH", confirmed: false };
  if (shootingStar) return { name: "Shooting star", signal: "BEARISH / SHORT WATCH", confirmed: false };
  if (doji) return { name: "Doji", signal: "INDECISION - WAIT FOR BREAK", confirmed: false };
  if (insideBar) return { name: "Inside bar", signal: "CONSOLIDATION - WAIT FOR BREAK", confirmed: false };
  return { name: current.close > current.open ? "Bullish candle" : "Bearish candle", signal: "NO CONFIRMED PATTERN", confirmed: false };
}

export function buildTechnicalPlan(candles: Candle[], options: OptionContext) {
  if (!candles.length) return null;
  const recent = candles.slice(-Math.min(candles.length, 60));
  const closes = recent.map((candle) => candle.close);
  const current = recent.at(-1)!;
  const previous = recent.at(-2) ?? current;
  const ema9 = emaValues(closes, 9).at(-1) ?? closes.at(-1) ?? 0;
  const ema21 = emaValues(closes, 21).at(-1) ?? closes.at(-1) ?? 0;
  const lookback = recent.slice(-Math.min(recent.length, 20));
  const priceSupport = lookback.length ? Math.min(...lookback.map((candle) => candle.low)) : current.low;
  const priceResistance = lookback.length ? Math.max(...lookback.map((candle) => candle.high)) : current.high;
  const optionSupportRelevant = options.support !== undefined && Math.abs(options.support - current.close) / current.close < 0.1;
  const optionResistanceRelevant = options.resistance !== undefined && Math.abs(options.resistance - current.close) / current.close < 0.1;
  const support = optionSupportRelevant ? Math.min(priceSupport, options.support!) : priceSupport;
  const resistance = optionResistanceRelevant ? Math.max(priceResistance, options.resistance!) : priceResistance;
  const atrWindow = recent.slice(-Math.min(recent.length, 14));
  const atr = atrWindow.length ? atrWindow.reduce((sum, candle) => sum + candle.high - candle.low, 0) / atrWindow.length : 0;
  const averageVolume = lookback.length ? lookback.reduce((sum, candle) => sum + candle.volume, 0) / lookback.length : 0;
  const pattern = candlePattern(current, previous);
  const bullishCandle = pattern.signal.includes("BULLISH") && pattern.confirmed;
  const bearishCandle = pattern.signal.includes("BEARISH") && pattern.confirmed;
  const side = ema9 > ema21 && bullishCandle ? "LONG" : ema9 < ema21 && bearishCandle ? "SHORT" : ema9 >= ema21 ? "WATCH LONG" : "WATCH SHORT";
  const entry = current.close;
  const longRisk = Math.max(Math.abs(entry - support), atr * 0.8, 0.0001);
  const shortRisk = Math.max(Math.abs(resistance - entry), atr * 0.8, 0.0001);
  const stop = side.includes("LONG") ? Math.max(support, entry - longRisk) : Math.min(resistance, entry + shortRisk);
  const longReward = Math.max(Math.abs(resistance - entry) * 1.5, Math.abs(entry - support) * 1.2, atr * 2, 0.0001);
  const shortReward = Math.max(Math.abs(entry - support) * 1.5, Math.abs(resistance - entry) * 1.2, atr * 2, 0.0001);
  const target = side.includes("LONG") ? entry + longReward : entry - shortReward;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const riskReward = risk > 0 ? reward / risk : 0;
  const riskRewardLabel = `1:${riskReward.toFixed(2)}`;
  return { side, entry, stop, target, support, resistance, ema9, ema21, volumeRatio: averageVolume ? current.volume / averageVolume : 0, candle: pattern.name, candleSignal: pattern.signal, candleConfirmed: pattern.confirmed, optionSupport: options.supportStrike, optionResistance: options.resistanceStrike, callLtp: options.callLtp, putLtp: options.putLtp, optionSource: options.source, riskReward, riskRewardLabel };
}
