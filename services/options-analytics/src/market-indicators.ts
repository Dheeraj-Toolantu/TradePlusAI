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

/** Wilder RSI: seeded on the first `period` changes, then smoothed through the latest close. */
export function rsi(values: number[], period = 14): IndicatorResult<number> {
  const early = insufficient<number>(period < 1 || values.length <= period);
  if (early) return early;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) { const change = values[index] - values[index - 1]; averageGain += Math.max(change, 0); averageLoss += Math.max(-change, 0); }
  averageGain /= period;
  averageLoss /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return { status: "READY", value: averageGain === 0 ? 50 : 100 };
  return { status: "READY", value: 100 - 100 / (1 + averageGain / averageLoss) };
}

/** MACD with the signal line as an EMA of the whole MACD series (from the first valid slow EMA). */
export function macd(values: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): IndicatorResult<MacdValue> {
  const early = insufficient<MacdValue>(values.length < slowPeriod + signalPeriod || fastPeriod < 1 || slowPeriod < fastPeriod);
  if (early) return early;
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdValues = values.map((_, index) => fast[index] - slow[index]).slice(slowPeriod - 1);
  const signal = ema(macdValues, signalPeriod).at(-1)!;
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

/** Supertrend: Wilder ATR on true range, final bands carried forward, direction flips on a close through the band. */
export function supertrend(highs: number[], lows: number[], closes: number[], period = 10, multiplier = 3): IndicatorResult<SupertrendValue> {
  const early = insufficient<SupertrendValue>(period < 1 || highs.length <= period || lows.length !== highs.length || closes.length !== highs.length);
  if (early) return early;
  const trueRange = (index: number) => index === 0 ? highs[0] - lows[0] : Math.max(highs[index] - lows[index], Math.abs(highs[index] - closes[index - 1]), Math.abs(lows[index] - closes[index - 1]));
  let atr = 0;
  for (let index = 1; index <= period; index += 1) atr += trueRange(index);
  atr /= period;
  let upper = (highs[period] + lows[period]) / 2 + multiplier * atr;
  let lower = (highs[period] + lows[period]) / 2 - multiplier * atr;
  let direction: "UP" | "DOWN" = closes[period] >= lower ? "UP" : "DOWN";
  for (let index = period + 1; index < closes.length; index += 1) {
    atr = (atr * (period - 1) + trueRange(index)) / period;
    const middle = (highs[index] + lows[index]) / 2;
    const basicUpper = middle + multiplier * atr;
    const basicLower = middle - multiplier * atr;
    upper = basicUpper < upper || closes[index - 1] > upper ? basicUpper : upper;
    lower = basicLower > lower || closes[index - 1] < lower ? basicLower : lower;
    if (direction === "UP" && closes[index] < lower) direction = "DOWN";
    else if (direction === "DOWN" && closes[index] > upper) direction = "UP";
  }
  return { status: "READY", value: { value: direction === "UP" ? lower : upper, direction } };
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