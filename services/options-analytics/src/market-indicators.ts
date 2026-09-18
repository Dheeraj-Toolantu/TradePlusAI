export function ema(values: number[], period: number): number[] {
  if (period < 1 || values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  return values.reduce<number[]>((result, value, index) => {
    result.push(index === 0 ? value : (value - result[index - 1]) * multiplier + result[index - 1]);
    return result;
  }, []);
}

export function vwap(prices: number[], volumes: number[]): number {
  const totalVolume = volumes.reduce((sum, volume) => sum + volume, 0);
  return totalVolume === 0 ? 0 : prices.reduce((sum, price, index) => sum + price * (volumes[index] ?? 0), 0) / totalVolume;
}

export function priceAction(highs: number[], lows: number[]): "BULLISH" | "BEARISH" | "RANGE" {
  if (highs.length < 2 || lows.length < 2) return "RANGE";
  const higherHigh = highs.at(-1)! > highs.at(-2)!;
  const higherLow = lows.at(-1)! > lows.at(-2)!;
  if (higherHigh && higherLow) return "BULLISH";
  if (!higherHigh && !higherLow) return "BEARISH";
  return "RANGE";
}

type IndicatorResult<T> = { status: "READY"; value: T } | { status: "INSUFFICIENT_DATA"; value: null };
export type BollingerValue = { middle: number; upper: number; lower: number };
export type MacdValue = { macd: number; signal: number; histogram: number };
export type SupertrendValue = { value: number; direction: "UP" | "DOWN" };
export type CprValue = { pivot: number; bc: number; tc: number };
export type PivotValue = { pivot: number; r1: number; r2: number; s1: number; s2: number };

function insufficient<T>(condition: boolean): IndicatorResult<T> | undefined { return condition ? { status: "INSUFFICIENT_DATA", value: null } : undefined; }

export function rsi(values: number[], period = 14): IndicatorResult<number> {
  const early = insufficient<number>(period < 1 || values.length <= period);
  if (early) return early;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) { const change = values[index] - values[index - 1]; gains += Math.max(change, 0); losses += Math.max(-change, 0); }
  const averageGain = gains / period;
  const averageLoss = losses / period;
  return { status: "READY", value: averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss) };
}

export function macd(values: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): IndicatorResult<MacdValue> {
  const early = insufficient<MacdValue>(values.length < slowPeriod + signalPeriod || fastPeriod < 1 || slowPeriod < fastPeriod);
  if (early) return early;
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdValues = values.map((_, index) => fast[index] - slow[index]);
  const signal = ema(macdValues.slice(-signalPeriod), signalPeriod).at(-1)!;
  const current = macdValues.at(-1)!;
  return { status: "READY", value: { macd: current, signal, histogram: current - signal } };
}

export function bollingerBands(values: number[], period = 20, deviationMultiplier = 2): IndicatorResult<BollingerValue> {
  const early = insufficient<BollingerValue>(period < 1 || values.length < period);
  if (early) return early;
  const sample = values.slice(-period);
  const middle = sample.reduce((sum, value) => sum + value, 0) / period;
  const deviation = Math.sqrt(sample.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period);
  return { status: "READY", value: { middle, upper: middle + deviation * deviationMultiplier, lower: middle - deviation * deviationMultiplier } };
}

export function supertrend(highs: number[], lows: number[], closes: number[], period = 10, multiplier = 3): IndicatorResult<SupertrendValue> {
  const early = insufficient<SupertrendValue>(period < 1 || highs.length < period || lows.length !== highs.length || closes.length !== highs.length);
  if (early) return early;
  const ranges = highs.slice(-period).map((high, index) => high - lows.slice(-period)[index]);
  const atr = ranges.reduce((sum, value) => sum + value, 0) / period;
  const middle = (highs.at(-1)! + lows.at(-1)!) / 2;
  const value = middle - multiplier * atr;
  return { status: "READY", value: { value, direction: closes.at(-1)! >= value ? "UP" : "DOWN" } };
}

export function cpr(high: number, low: number, close: number): IndicatorResult<CprValue> {
  if (![high, low, close].every(Number.isFinite) || high < low) return { status: "INSUFFICIENT_DATA", value: null };
  const pivot = (high + low + close) / 3;
  const bc = (high + low) / 2;
  return { status: "READY", value: { pivot, bc, tc: 2 * pivot - bc } };
}

export function pivots(high: number, low: number, close: number): PivotValue {
  const pivot = (high + low + close) / 3;
  return { pivot, r1: 2 * pivot - low, r2: pivot + high - low, s1: 2 * pivot - high, s2: pivot - high + low };
}