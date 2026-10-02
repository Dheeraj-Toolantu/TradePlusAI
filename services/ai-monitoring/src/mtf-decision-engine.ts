/**
 * Multi-timeframe decision engine for intraday index option BUYERS (NIFTY / BANKNIFTY / SENSEX).
 *
 * Top-down, the way a desk trader reads a chart:
 *   1D  -> context: daily trend, previous day high/low/close, where today trades in the range.
 *   15m -> direction: the intraday trend we are allowed to trade with.
 *   5m  -> setup: pullback to value (EMA20 / VWAP / a key level) or a break-and-hold of structure.
 *   1m  -> trigger: a confirming candle (engulfing, pin bar, hammer...) or a 1m break of structure.
 *
 * Candlestick patterns are read for their psychology (who got trapped, who is in control) and only
 * count when they print AT a level, with volume when volume is available.
 *
 * The option leg is valued too: intrinsic vs time value, and a Black-Scholes fair value from the
 * ATM IV, so the trader knows how much premium is pure time decay and whether it is overpriced.
 *
 * Pure and IO-free: callers pass completed candles. Forming candles are dropped here as well so a
 * candle that is still printing can never trigger an entry (no repainting / look-ahead).
 */

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number | null };
export type TimeframeKey = "1D" | "15m" | "5m" | "1m";
export type Bias = "BULLISH" | "BEARISH" | "NEUTRAL";

export type CandlePattern = {
  name: string;
  bias: Bias;
  /** 1 = weak, 2 = normal, 3 = strong (after location / volume context). */
  strength: number;
  psychology: string;
  /** Key level the pattern printed at, if any. */
  atLevel?: string;
  volumeConfirmed?: boolean;
};

export type TimeframeRead = {
  timeframe: TimeframeKey;
  bars: number;
  trend: "UP" | "DOWN" | "SIDEWAYS";
  structure: "HIGHER_HIGHS_LOWS" | "LOWER_HIGHS_LOWS" | "MIXED";
  /** -100 (strongly bearish) .. +100 (strongly bullish). */
  score: number;
  close: number;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  vwap: number | null;
  swingHigh: number | null;
  swingLow: number | null;
  patterns: CandlePattern[];
  notes: string[];
};

export type KeyLevel = { label: string; price: number; kind: "SUPPORT" | "RESISTANCE" };

export type OptionValuation = {
  side: "CE" | "PE";
  tradingSymbol: string;
  strike: number;
  premium: number;
  intrinsic: number;
  extrinsic: number;
  /** Share of the premium that is time value (decays to zero by expiry). */
  extrinsicPct: number;
  fairValue: number | null;
  verdict: "UNDERVALUED" | "FAIR" | "OVERPRICED" | "UNKNOWN";
  note: string;
};

export type MtfCandidate = { side: "CE" | "PE"; trading_symbol: string; strike: number; premium: number; delta: number | null };

export type MtfInput = {
  symbol: string;
  spot: number;
  candles: Partial<Record<TimeframeKey, Bar[]>>;
  candidates?: Partial<Record<"CE" | "PE", MtfCandidate | null>>;
  /** ATM implied volatility in percent (e.g. 13.5). */
  atmIv?: number | null;
  /** Expiry date YYYY-MM-DD (options settle 15:30 IST). */
  expiry?: string | null;
  now?: Date;
};

export type MtfDecision = {
  action: "BUY_CE" | "BUY_PE" | "WAIT";
  confidence: number;
  alignment: "BULLISH_ALIGNED" | "BEARISH_ALIGNED" | "MIXED" | "INSUFFICIENT_DATA";
  headline: string;
  timeframes: Record<TimeframeKey, TimeframeRead | null>;
  levels: KeyLevel[];
  spot: { entry: number; entryLow: number; entryHigh: number; stop: number; target1: number; target2: number; riskPoints: number; riskReward: number } | null;
  trigger: string;
  invalidation: string;
  reasons: string[];
  risks: string[];
  psychology: string[];
  exitPlan: string[];
  valuation: Partial<Record<"CE" | "PE", OptionValuation>>;
  blockedBy: string[];
  generatedAt: string;
};

const TF_MINUTES: Record<TimeframeKey, number> = { "1D": 1440, "15m": 15, "5m": 5, "1m": 1 };
const IST_OFFSET_S = 330 * 60;
const MIN_BARS: Record<TimeframeKey, number> = { "1D": 20, "15m": 20, "5m": 30, "1m": 15 };
const MIN_RISK_REWARD = 2;
const MIN_CONFIDENCE = 60;

const round2 = (value: number) => Math.round(value * 100) / 100;
const istDay = (epochSeconds: number) => new Date((epochSeconds + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
const istMinutes = (date: Date) => { const ist = new Date(date.getTime() + IST_OFFSET_S * 1000); return ist.getUTCHours() * 60 + ist.getUTCMinutes(); };

// ---------------------------------------------------------------- indicators

function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i += 1) { prev = (values[i] - prev) * k + prev; out.push(prev); }
  return out;
}
const lastEma = (values: number[], period: number) => emaSeries(values, period).at(-1) ?? null;

/** Wilder RSI over the most recent data. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0; let loss = 0;
  for (let i = 1; i <= period; i += 1) { const change = values[i] - values[i - 1]; if (change >= 0) gain += change; else loss -= change; }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * Wilder ATR. On intraday bars the first bar of each IST session uses its own high-low: the overnight
 * gap is not intraday volatility, and counting it would widen every stop for the first hour.
 */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length <= period) return null;
  const intraday = bars.length > 1 && bars[1].time - bars[0].time < 86_400;
  const trs = bars.slice(1).map((bar, i) => (intraday && istDay(bar.time) !== istDay(bars[i].time)
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i].close), Math.abs(bar.low - bars[i].close))));
  let value = trs.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (let i = period; i < trs.length; i += 1) value = (value * (period - 1) + trs[i]) / period;
  return value;
}

/** Session VWAP of the latest IST trading day (typical price; TWAP when volume is missing). */
function sessionVwap(bars: Bar[]): number | null {
  if (!bars.length) return null;
  const day = istDay(bars.at(-1)!.time);
  const session = bars.filter((bar) => istDay(bar.time) === day);
  const volume = session.reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
  const typical = (bar: Bar) => (bar.high + bar.low + bar.close) / 3;
  return volume > 0 ? session.reduce((sum, bar) => sum + typical(bar) * (bar.volume ?? 0), 0) / volume : session.reduce((sum, bar) => sum + typical(bar), 0) / session.length;
}

/** Fractal swing points (left/right strength 2). */
function swings(bars: Bar[], strength = 2) {
  const highs: Array<{ index: number; price: number }> = [];
  const lows: Array<{ index: number; price: number }> = [];
  for (let i = strength; i < bars.length - strength; i += 1) {
    const window = bars.slice(i - strength, i + strength + 1);
    if (window.every((bar, j) => j === strength || bar.high < bars[i].high)) highs.push({ index: i, price: bars[i].high });
    if (window.every((bar, j) => j === strength || bar.low > bars[i].low)) lows.push({ index: i, price: bars[i].low });
  }
  return { highs, lows };
}

/** Removes the candle that is still forming, so decisions only use closed candles. */
export function completedBars(bars: Bar[] | undefined, timeframe: TimeframeKey, now = new Date()): Bar[] {
  if (!bars?.length) return [];
  const clean = bars.filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.high >= bar.low).sort((a, b) => a.time - b.time);
  const nowS = now.getTime() / 1000;
  if (timeframe === "1D") {
    // Today's daily bar is still forming during the session.
    const today = istDay(nowS);
    return clean.filter((bar) => istDay(bar.time) < today);
  }
  return clean.filter((bar) => bar.time + TF_MINUTES[timeframe] * 60 <= nowS);
}

// ------------------------------------------------------------- candle patterns

const body = (bar: Bar) => Math.abs(bar.close - bar.open);
const range = (bar: Bar) => Math.max(bar.high - bar.low, 1e-9);
const upperWick = (bar: Bar) => bar.high - Math.max(bar.open, bar.close);
const lowerWick = (bar: Bar) => Math.min(bar.open, bar.close) - bar.low;
const isBull = (bar: Bar) => bar.close > bar.open;
const isBear = (bar: Bar) => bar.close < bar.open;

/**
 * Reads the last closed candles for the classic reversal/continuation patterns. Strength is raised
 * when the pattern prints at a key level (within 0.3 ATR) and when its volume is above average.
 */
export function detectPatterns(bars: Bar[], levels: KeyLevel[] = [], atrValue: number | null = null): CandlePattern[] {
  if (bars.length < 3) return [];
  const [a, b, c] = bars.slice(-3);
  const prior = bars.slice(-8, -1);
  const fell = prior.length >= 3 && prior.at(-1)!.close < prior[0].close;
  const rose = prior.length >= 3 && prior.at(-1)!.close > prior[0].close;
  const found: CandlePattern[] = [];
  const add = (name: string, bias: Bias, strength: number, psychology: string) => found.push({ name, bias, strength, psychology });

  if (isBull(c) && isBear(b) && c.close >= b.open && c.open <= b.close && body(c) > body(b)) add("Bullish engulfing", "BULLISH", 2, "Sellers who pressed the last candle are now trapped below; buyers absorbed all of it and closed above their open.");
  if (isBear(c) && isBull(b) && c.close <= b.open && c.open >= b.close && body(c) > body(b)) add("Bearish engulfing", "BEARISH", 2, "Late buyers of the last candle are trapped; sellers overwhelmed them and closed below their open.");
  if (lowerWick(c) >= 2 * body(c) && lowerWick(c) >= 0.55 * range(c) && upperWick(c) <= 0.25 * range(c)) {
    if (fell) add("Hammer", "BULLISH", 2, "Sellers pushed price down, but buyers rejected the low hard: stop-losses below were hunted and absorbed.");
    // The same shape after a rally is a hanging man: buyers could not stop an intrabar sell-off.
    else if (rose) add("Hanging man", "BEARISH", 1, "After a rally, sellers drove price well below the open intrabar: long holders are nervous and the up-move is tiring.");
    else add("Bullish pin bar", "BULLISH", 1, "Long lower wick: lower prices were rejected by buyers.");
  }
  if (upperWick(c) >= 2 * body(c) && upperWick(c) >= 0.55 * range(c) && lowerWick(c) <= 0.25 * range(c)) {
    if (rose) add("Shooting star", "BEARISH", 2, "Buyers chased higher, but sellers rejected the high: breakout buyers are now trapped above.");
    // The same shape after a decline is an inverted hammer: buyers are probing for the first time.
    else if (fell) add("Inverted hammer", "BULLISH", 1, "After a decline, buyers pushed price well above the open intrabar: the first sign that sellers are losing control.");
    else add("Bearish pin bar", "BEARISH", 1, "Long upper wick: higher prices were rejected by sellers.");
  }
  if (body(c) <= 0.1 * range(c)) add("Doji", "NEUTRAL", 1, "Indecision: neither side is in control. Wait for the next candle to show who wins.");
  if (body(c) >= 0.85 * range(c) && range(c) > 0) add(isBull(c) ? "Bullish marubozu" : "Bearish marubozu", isBull(c) ? "BULLISH" : "BEARISH", 2, isBull(c) ? "Buyers in full control from open to close: no meaningful selling." : "Sellers in full control from open to close: no meaningful buying.");
  if (c.high <= b.high && c.low >= b.low) add("Inside bar", "NEUTRAL", 1, "Compression after the previous candle: energy is building. Trade the break of the mother bar, not the inside bar.");
  // Stars need a real first candle (≥ 0.6 ATR body), a meaningful third candle, and the right prior
  // trend; three tiny bars are noise, not exhaustion.
  const starSize = (first: Bar, third: Bar) => body(first) >= 0.6 * (atrValue ?? range(first)) && body(third) >= 0.5 * body(first);
  if (fell && starSize(a, c) && isBear(a) && body(b) <= 0.35 * body(a) && isBull(c) && c.close > (a.open + a.close) / 2) add("Morning star", "BULLISH", 3, "Selling exhausted (small middle candle), then buyers reclaimed more than half the down candle: a classic bottom.");
  if (rose && starSize(a, c) && isBull(a) && body(b) <= 0.35 * body(a) && isBear(c) && c.close < (a.open + a.close) / 2) add("Evening star", "BEARISH", 3, "Buying exhausted, then sellers took back more than half the up candle: a classic top.");
  if ([a, b, c].every(isBull) && b.close > a.close && c.close > b.close && [a, b, c].every((bar) => body(bar) >= 0.5 * range(bar))) add("Three white soldiers", "BULLISH", 2, "Three strong closes in a row: steady institutional buying, not a one-candle spike.");
  if ([a, b, c].every(isBear) && b.close < a.close && c.close < b.close && [a, b, c].every((bar) => body(bar) >= 0.5 * range(bar))) add("Three black crows", "BEARISH", 2, "Three strong down closes in a row: steady distribution.");
  if (Math.abs(b.low - c.low) <= 0.1 * range(c) && isBear(b) && isBull(c) && fell) add("Tweezer bottom", "BULLISH", 2, "The same low defended twice: buyers are holding that price.");
  if (Math.abs(b.high - c.high) <= 0.1 * range(c) && isBull(b) && isBear(c) && rose) add("Tweezer top", "BEARISH", 2, "The same high rejected twice: sellers are defending that price.");

  const volumes = bars.slice(-21, -1).map((bar) => bar.volume ?? 0).filter((v) => v > 0);
  const avgVolume = volumes.length ? volumes.reduce((sum, v) => sum + v, 0) / volumes.length : 0;
  const tolerance = (atrValue ?? range(c)) * 0.3;
  for (const pattern of found) {
    if (pattern.bias === "NEUTRAL") continue;
    const wantKind = pattern.bias === "BULLISH" ? "SUPPORT" : "RESISTANCE";
    const probe = pattern.bias === "BULLISH" ? Math.min(b.low, c.low) : Math.max(b.high, c.high);
    const level = levels.find((item) => item.kind === wantKind && Math.abs(item.price - probe) <= tolerance);
    if (level) { pattern.atLevel = level.label; pattern.strength = Math.min(3, pattern.strength + 1); }
    if (avgVolume > 0 && (c.volume ?? 0) >= 1.2 * avgVolume) { pattern.volumeConfirmed = true; pattern.strength = Math.min(3, pattern.strength + 1); }
  }
  return found;
}

// ------------------------------------------------------------- timeframe read

function readTimeframe(timeframe: TimeframeKey, bars: Bar[], levels: KeyLevel[]): TimeframeRead | null {
  if (bars.length < MIN_BARS[timeframe]) return null;
  const closes = bars.map((bar) => bar.close);
  const close = closes.at(-1)!;
  const ema20 = lastEma(closes, 20);
  const ema50 = lastEma(closes, 50);
  const ema20Series = emaSeries(closes, 20);
  const slope = ema20Series.length > 5 ? ema20Series.at(-1)! - ema20Series.at(-6)! : 0;
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const intraday = timeframe !== "1D";
  const vwap = intraday ? sessionVwap(bars) : null;
  const { highs, lows } = swings(bars);
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const structure = h1 && h2 && l1 && l2
    ? (h2.price > h1.price && l2.price > l1.price ? "HIGHER_HIGHS_LOWS" : h2.price < h1.price && l2.price < l1.price ? "LOWER_HIGHS_LOWS" : "MIXED")
    : "MIXED";

  const votes: number[] = [];
  const notes: string[] = [];
  if (ema20 !== null) { votes.push(close > ema20 ? 1 : -1); }
  if (ema20 !== null && ema50 !== null) votes.push(ema20 > ema50 ? 1 : -1);
  if (atr14 && Math.abs(slope) > atr14 * 0.15) votes.push(slope > 0 ? 1 : -1); else votes.push(0);
  votes.push(structure === "HIGHER_HIGHS_LOWS" ? 1.5 : structure === "LOWER_HIGHS_LOWS" ? -1.5 : 0);
  if (rsi14 !== null) votes.push(rsi14 >= 55 ? 0.5 : rsi14 <= 45 ? -0.5 : 0);
  if (vwap !== null) votes.push(close > vwap ? 1 : -1);
  const maxVotes = 1 + 1 + 1 + 1.5 + 0.5 + (vwap !== null ? 1 : 0);
  const score = Math.round((votes.reduce((sum, v) => sum + v, 0) / maxVotes) * 100);
  const trend = score >= 35 ? "UP" : score <= -35 ? "DOWN" : "SIDEWAYS";
  if (rsi14 !== null && rsi14 >= 75) notes.push(`RSI ${rsi14.toFixed(0)}: overbought, late longs are vulnerable`);
  if (rsi14 !== null && rsi14 <= 25) notes.push(`RSI ${rsi14.toFixed(0)}: oversold, late shorts are vulnerable`);
  if (atr14 && ema20 !== null && Math.abs(close - ema20) > 2 * atr14) notes.push(`Price is ${(Math.abs(close - ema20) / atr14).toFixed(1)} ATR from EMA20: extended, avoid chasing`);

  return {
    timeframe, bars: bars.length, trend, structure, score, close: round2(close),
    ema20: ema20 === null ? null : round2(ema20), ema50: ema50 === null ? null : round2(ema50),
    rsi14: rsi14 === null ? null : Math.round(rsi14 * 10) / 10, atr14: atr14 === null ? null : round2(atr14), vwap: vwap === null ? null : round2(vwap),
    swingHigh: highs.at(-1)?.price ?? null, swingLow: lows.at(-1)?.price ?? null,
    patterns: detectPatterns(bars, levels, atr14), notes,
  };
}

// ------------------------------------------------------------------ key levels

function keyLevels(spot: number, daily: Bar[], m15: Bar[], m5: Bar[], symbol: string): KeyLevel[] {
  const levels: Array<{ label: string; price: number }> = [];
  const prev = daily.at(-1);
  if (prev) levels.push({ label: "Previous day high", price: prev.high }, { label: "Previous day low", price: prev.low }, { label: "Previous day close", price: prev.close });
  if (daily.length >= 5) {
    const week = daily.slice(-5);
    levels.push({ label: "5-day high", price: Math.max(...week.map((bar) => bar.high)) }, { label: "5-day low", price: Math.min(...week.map((bar) => bar.low)) });
  }
  if (prev) {
    const pivot = (prev.high + prev.low + prev.close) / 3;
    levels.push({ label: "Daily pivot", price: pivot }, { label: "Pivot R1", price: 2 * pivot - prev.low }, { label: "Pivot S1", price: 2 * pivot - prev.high });
  }
  const intraday = m5.length ? m5 : m15;
  if (intraday.length) {
    const day = istDay(intraday.at(-1)!.time);
    const today = intraday.filter((bar) => istDay(bar.time) === day);
    if (today.length) levels.push({ label: "Day open", price: today[0].open }, { label: "Day high", price: Math.max(...today.map((bar) => bar.high)) }, { label: "Day low", price: Math.min(...today.map((bar) => bar.low)) });
  }
  const s15 = swings(m15.slice(-60));
  for (const swing of s15.highs.slice(-2)) levels.push({ label: "15m swing high", price: swing.price });
  for (const swing of s15.lows.slice(-2)) levels.push({ label: "15m swing low", price: swing.price });
  const step = symbol === "BANKNIFTY" || symbol === "SENSEX" ? 500 : 100;
  levels.push({ label: `Round number ${Math.floor(spot / step) * step}`, price: Math.floor(spot / step) * step }, { label: `Round number ${Math.ceil(spot / step) * step}`, price: Math.ceil(spot / step) * step });
  return levels
    .filter((level) => Number.isFinite(level.price) && level.price > 0)
    .map((level) => ({ label: level.label, price: round2(level.price), kind: level.price <= spot ? "SUPPORT" as const : "RESISTANCE" as const }))
    .sort((a, b) => a.price - b.price);
}

// ------------------------------------------------------------ option valuation

function normCdf(x: number) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Black-Scholes value (no dividends) with r = 6.5%. */
export function blackScholes(side: "CE" | "PE", spot: number, strike: number, years: number, ivPct: number, rate = 0.065): number {
  const sigma = ivPct / 100;
  if (years <= 0 || sigma <= 0) return Math.max(0, side === "CE" ? spot - strike : strike - spot);
  const d1 = (Math.log(spot / strike) + (rate + sigma * sigma / 2) * years) / (sigma * Math.sqrt(years));
  const d2 = d1 - sigma * Math.sqrt(years);
  return side === "CE"
    ? spot * normCdf(d1) - strike * Math.exp(-rate * years) * normCdf(d2)
    : strike * Math.exp(-rate * years) * normCdf(-d2) - spot * normCdf(-d1);
}

export function valueOption(candidate: MtfCandidate, spot: number, atmIv: number | null | undefined, expiry: string | null | undefined, now = new Date()): OptionValuation {
  const intrinsic = Math.max(0, candidate.side === "CE" ? spot - candidate.strike : candidate.strike - spot);
  const extrinsic = Math.max(0, candidate.premium - intrinsic);
  const extrinsicPct = candidate.premium > 0 ? Math.round((extrinsic / candidate.premium) * 100) : 0;
  let fairValue: number | null = null;
  if (atmIv && atmIv > 0 && expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    const settle = Date.parse(`${expiry}T10:00:00Z`); // 15:30 IST
    const years = Math.max((settle - now.getTime()) / (365 * 24 * 3600 * 1000), 1 / (365 * 24 * 12));
    fairValue = round2(blackScholes(candidate.side, spot, candidate.strike, years, atmIv));
  }
  let verdict: OptionValuation["verdict"] = "UNKNOWN";
  if (fairValue !== null && fairValue > 0) verdict = candidate.premium > fairValue * 1.12 ? "OVERPRICED" : candidate.premium < fairValue * 0.9 ? "UNDERVALUED" : "FAIR";
  const parts = [`Intrinsic ₹${round2(intrinsic)} + time value ₹${round2(extrinsic)} (${extrinsicPct}% of premium decays by expiry)`];
  if (fairValue !== null) parts.push(`fair value ≈ ₹${fairValue} at ${atmIv}% IV → ${verdict.toLowerCase()}`);
  return { side: candidate.side, tradingSymbol: candidate.trading_symbol, strike: candidate.strike, premium: candidate.premium, intrinsic: round2(intrinsic), extrinsic: round2(extrinsic), extrinsicPct, fairValue, verdict, note: parts.join("; ") };
}

// --------------------------------------------------------------------- decision

const strongest = (patterns: CandlePattern[], bias: Bias) => patterns.filter((pattern) => pattern.bias === bias).sort((a, b) => b.strength - a.strength)[0];

export function analyzeMultiTimeframe(input: MtfInput): MtfDecision {
  const now = input.now ?? new Date();
  const daily = completedBars(input.candles["1D"], "1D", now);
  const m15 = completedBars(input.candles["15m"], "15m", now);
  const m5 = completedBars(input.candles["5m"], "5m", now);
  const m1 = completedBars(input.candles["1m"], "1m", now);
  const spot = input.spot > 0 ? input.spot : m1.at(-1)?.close ?? m5.at(-1)?.close ?? 0;
  const levels = spot > 0 ? keyLevels(spot, daily, m15, m5, input.symbol) : [];
  const timeframes: Record<TimeframeKey, TimeframeRead | null> = {
    "1D": readTimeframe("1D", daily, levels),
    "15m": readTimeframe("15m", m15, levels),
    "5m": readTimeframe("5m", m5, levels),
    "1m": readTimeframe("1m", m1, levels),
  };
  const valuation: MtfDecision["valuation"] = {};
  for (const side of ["CE", "PE"] as const) {
    const candidate = input.candidates?.[side];
    if (candidate && candidate.premium > 0 && spot > 0) valuation[side] = valueOption(candidate, spot, input.atmIv, input.expiry, now);
  }
  const base = { timeframes, levels, valuation, generatedAt: now.toISOString() };
  const wait = (headline: string, extra: Partial<MtfDecision> = {}): MtfDecision => ({
    action: "WAIT", confidence: 0, alignment: "MIXED", headline, spot: null, trigger: "", invalidation: "", reasons: [], risks: [], psychology: [], exitPlan: [], blockedBy: [], ...base, ...extra,
  });

  const { "1D": d, "15m": t15, "5m": t5, "1m": t1 } = timeframes;
  if (!t15 || !t5 || !t1 || spot <= 0) {
    const missing = (["15m", "5m", "1m"] as const).filter((tf) => !timeframes[tf]);
    return wait(`Not enough closed candles on ${missing.join(", ") || "price"} for a multi-timeframe read`, { alignment: "INSUFFICIENT_DATA" });
  }

  const blockedBy: string[] = [];
  const minutes = istMinutes(now);
  if (minutes < 9 * 60 + 30) blockedBy.push("First 15 minutes after the open: spreads are wide and moves are erratic");
  if (minutes >= 14 * 60 + 45) blockedBy.push("After 14:45 IST: not enough time left for an option buy to work before square-off");

  // Weighted top-down bias: 15m sets direction, 1D gives context, 5m/1m refine.
  const weighted = (d?.score ?? 0) * 0.25 + t15.score * 0.35 + t5.score * 0.25 + t1.score * 0.15;
  const dailyAgainst = (side: 1 | -1) => d !== null && d.score * side <= -60;
  let side: 1 | -1 | 0 = 0;
  if (t15.trend === "UP" && t5.trend !== "DOWN" && !dailyAgainst(1)) side = 1;
  else if (t15.trend === "DOWN" && t5.trend !== "UP" && !dailyAgainst(-1)) side = -1;
  const alignment: MtfDecision["alignment"] = side > 0 ? "BULLISH_ALIGNED" : side < 0 ? "BEARISH_ALIGNED" : "MIXED";
  const tfLine = (tf: TimeframeRead | null, key: TimeframeKey) => tf ? `${key} ${tf.trend.toLowerCase()} (${tf.score > 0 ? "+" : ""}${tf.score}, ${tf.structure.replaceAll("_", " ").toLowerCase()})` : `${key} n/a`;
  const context = [tfLine(d, "1D"), tfLine(t15, "15m"), tfLine(t5, "5m"), tfLine(t1, "1m")].join(" · ");
  if (side === 0) {
    return wait(`Timeframes disagree: ${context}`, { alignment, blockedBy, reasons: [`Weighted bias ${weighted.toFixed(0)}`], psychology: ["When higher and lower timeframes disagree, both buyers and sellers are getting stopped out: that is chop, where option buyers bleed time value."] });
  }

  const bias: Bias = side > 0 ? "BULLISH" : "BEARISH";
  // A flat or stale feed rounds ATR to 0, which is not "known volatility": fall back to 0.15% of spot.
  const atr5 = t5.atr14 && t5.atr14 > 0 ? t5.atr14 : Math.max(spot * 0.0015, 1);
  const reasons: string[] = [`Top-down alignment: ${context}`];
  const risks: string[] = [];
  const psychology: string[] = [];

  // 5m setup: pullback to value or break-and-hold of structure, but never chasing an extended move.
  const supportsNear = levels.filter((level) => level.kind === (side > 0 ? "SUPPORT" : "RESISTANCE") && Math.abs(level.price - spot) <= 0.6 * atr5);
  const valueAreas = [t5.ema20, t5.vwap].filter((value): value is number => value !== null);
  // At value means at or just on the right side of it: a long 0.6 ATR BELOW VWAP is not "holding value".
  const atValue = valueAreas.some((value) => (spot - value) * side >= -0.2 * atr5 && (spot - value) * side <= 0.6 * atr5) || supportsNear.length > 0;
  // A break of structure counts only while it is fresh: the break happened within the last 3 closed
  // 5m bars. Price that has sat above an old swing for an hour is no longer a breakout entry.
  const recent5 = m5.slice(-4);
  const freshBreak = (level: number | null) => level !== null && recent5.length >= 2 && (spot - level) * side > 0 && recent5.slice(0, -1).some((bar) => (bar.close - level) * side <= 0);
  const brokeStructure = side > 0 ? freshBreak(t5.swingHigh) : freshBreak(t5.swingLow);
  const extended = t5.ema20 !== null && Math.abs(spot - t5.ema20) > 2 * atr5;
  if (extended) return wait(`${bias === "BULLISH" ? "Bullish" : "Bearish"} trend, but price is ${(Math.abs(spot - t5.ema20!) / atr5).toFixed(1)} ATR from the 5m EMA20: wait for a pullback instead of chasing`, { alignment, blockedBy, reasons, psychology: ["Chasing an extended move means buying from the traders who entered early and are now booking profit."] });
  if (!atValue && !brokeStructure) return wait(`${bias === "BULLISH" ? "Bullish" : "Bearish"} alignment, but price is between levels: wait for a pullback to 5m EMA20/VWAP${supportsNear.length ? "" : " or a key level"} or a break of the 5m swing`, { alignment, blockedBy, reasons });
  reasons.push(atValue ? `5m setup: pullback into value (${[...supportsNear.map((level) => level.label), ...(valueAreas.length ? ["EMA20/VWAP"] : [])].slice(0, 3).join(", ")})` : `5m setup: break of the last 5m swing ${side > 0 ? "high" : "low"}`);

  // 1m trigger: a confirming pattern or a 1m break of structure, on a closed candle.
  const trigger1m = strongest(t1.patterns, bias);
  const lastClosed = m1.at(-1)!;
  // The 1m break must happen on this candle (fresh cross), or the same break re-triggers every minute.
  const previousClosed = m1.at(-2);
  const microBreak = side > 0
    ? t1.swingHigh !== null && lastClosed.close > t1.swingHigh && previousClosed !== undefined && previousClosed.close <= t1.swingHigh
    : t1.swingLow !== null && lastClosed.close < t1.swingLow && previousClosed !== undefined && previousClosed.close >= t1.swingLow;
  const trigger5m = strongest(t5.patterns, bias);
  if (!trigger1m && !microBreak) {
    return wait(`Setup is ready on 5m; waiting for a 1-minute ${side > 0 ? "bullish" : "bearish"} confirmation candle or a 1m break of structure`, {
      alignment, blockedBy, reasons,
      trigger: side > 0 ? `Enter on a 1m bullish engulfing / hammer, or a 1m close above ${t1.swingHigh ?? "the last 1m swing high"}` : `Enter on a 1m bearish engulfing / shooting star, or a 1m close below ${t1.swingLow ?? "the last 1m swing low"}`,
    });
  }
  if (trigger1m) { reasons.push(`1m trigger: ${trigger1m.name}${trigger1m.atLevel ? ` at ${trigger1m.atLevel}` : ""}${trigger1m.volumeConfirmed ? " on above-average volume" : ""}`); psychology.push(trigger1m.psychology); }
  if (microBreak) reasons.push(`1m break of structure through ${side > 0 ? t1.swingHigh : t1.swingLow}`);
  if (trigger5m) { reasons.push(`5m candle: ${trigger5m.name}${trigger5m.atLevel ? ` at ${trigger5m.atLevel}` : ""}`); psychology.push(trigger5m.psychology); }
  const opposing = [strongest(t1.patterns, side > 0 ? "BEARISH" : "BULLISH"), strongest(t5.patterns, side > 0 ? "BEARISH" : "BULLISH")].filter((pattern): pattern is CandlePattern => Boolean(pattern));
  for (const pattern of opposing) risks.push(`Opposing ${pattern.name} on the chart: ${pattern.psychology}`);

  // Levels: stop beyond the structure that invalidates the idea; targets at the next liquidity.
  // Entry is the live spot (what the option is priced on now), not the last closed 1m bar.
  const entry = round2(spot);
  // Stop below the 1m trigger structure; include the 5m swing only when it is close enough to keep
  // the risk tradable for an option buyer (a distant 5m swing would make every stop too wide).
  const recent1m = m1.slice(-5);
  const structural = side > 0
    ? Math.min(...recent1m.map((bar) => bar.low), ...(t5.swingLow !== null && t5.swingLow < entry && entry - t5.swingLow <= 1.2 * atr5 ? [t5.swingLow] : []))
    : Math.max(...recent1m.map((bar) => bar.high), ...(t5.swingHigh !== null && t5.swingHigh > entry && t5.swingHigh - entry <= 1.2 * atr5 ? [t5.swingHigh] : []));
  let stop = structural - side * 0.1 * atr5;
  // Signed risk: if live price is already through the trigger structure, the setup is void (a long
  // with its stop above entry would be an instant loss).
  let riskPoints = (entry - stop) * side;
  if (!(riskPoints > 0)) return wait(`Live price is already through the 1m ${side > 0 ? "lows" : "highs"} that define the stop: setup invalidated`, { alignment, blockedBy, reasons });
  if (riskPoints < 0.4 * atr5) { stop = entry - side * 0.4 * atr5; riskPoints = 0.4 * atr5; }
  if (riskPoints > 1.5 * atr5) return wait(`Structure stop is ${(riskPoints / atr5).toFixed(1)} ATR away: too wide for an option buy, wait for a tighter entry`, { alignment, blockedBy, reasons });
  // Every level ahead counts, including one sitting right in front of the entry: buying just under
  // resistance (or selling just above support) is the classic retail trap.
  const ahead = levels.filter((level) => (level.price - entry) * side > 0).sort((a, b) => (a.price - b.price) * side);
  const nextLevel = ahead[0];
  const room = nextLevel ? Math.abs(nextLevel.price - entry) : Infinity;
  if (room < MIN_RISK_REWARD * riskPoints) {
    return wait(`Only ${(room / riskPoints).toFixed(1)}R of room before ${nextLevel!.label} (${nextLevel!.price}): reward does not justify the risk`, { alignment, blockedBy, reasons, risks: [...risks, `${nextLevel!.label} at ${nextLevel!.price} will attract profit booking and fresh opposite positions`] });
  }
  const target1 = round2(entry + side * MIN_RISK_REWARD * riskPoints);
  const beyond = ahead.find((level) => Math.abs(level.price - entry) >= 3 * riskPoints);
  // Cap T2 at 4R: a level several days away is not an intraday option target.
  const target2 = round2(beyond && Math.abs(beyond.price - entry) <= 4 * riskPoints ? beyond.price : entry + side * (beyond ? 4 : 3) * riskPoints);

  // Confidence: alignment strength + trigger quality + location, minus warning signs.
  // Only bias that points WITH the trade adds confidence.
  let confidence = 45 + Math.min(25, Math.max(0, weighted * side) * 0.35);
  if (trigger1m) confidence += trigger1m.strength * 4;
  if (microBreak) confidence += 4;
  if (trigger5m) confidence += trigger5m.strength * 3;
  if (atValue) confidence += 5;
  if (d && Math.sign(d.score) === side && Math.abs(d.score) >= 35) { confidence += 5; reasons.push(`Daily trend agrees (${d.trend.toLowerCase()})`); }
  else if (d && Math.sign(d.score) === -side && Math.abs(d.score) >= 35) { confidence -= 8; risks.push(`Daily trend is ${d.trend.toLowerCase()}: this is a counter-trend intraday trade, size down and take profits early`); }
  confidence -= opposing.length * 6;
  for (const tf of [t15, t5]) {
    if (tf.rsi14 !== null && ((side > 0 && tf.rsi14 >= 75) || (side < 0 && tf.rsi14 <= 25))) { confidence -= 6; risks.push(`${tf.timeframe} RSI ${tf.rsi14}: stretched, the move may pause`); }
  }
  const optionSide = side > 0 ? "CE" : "PE";
  const option = valuation[optionSide];
  if (option?.verdict === "OVERPRICED") { confidence -= 7; risks.push(`${option.tradingSymbol} looks expensive vs fair value (${option.note})`); }
  if (option && option.extrinsicPct >= 85 && option.extrinsic > 0) risks.push(`${option.extrinsicPct}% of the ${optionSide} premium is time value: the trade must work quickly`);
  if (blockedBy.length) confidence = Math.min(confidence, MIN_CONFIDENCE - 1);
  confidence = Math.max(0, Math.min(95, Math.round(confidence)));

  psychology.unshift(side > 0
    ? "Higher timeframes are up and price pulled back into value: sellers had their chance and failed, buyers who missed the move are entering on the dip."
    : "Higher timeframes are down and price bounced into resistance: buyers had their chance and failed, sellers are adding on the rally.");

  const spotPlan = { entry, entryLow: round2(side > 0 ? entry - 0.15 * atr5 : entry), entryHigh: round2(side > 0 ? entry : entry + 0.15 * atr5), stop: round2(stop), target1, target2, riskPoints: round2(riskPoints), riskReward: MIN_RISK_REWARD };
  const exitPlan = [
    `Stop: spot ${side > 0 ? "below" : "above"} ${spotPlan.stop}, beyond the 1m/5m structure; exit on a candle close through it, never average down.`,
    `Book half at T1 ${target1} (2R) and move the stop on the rest to entry.`,
    `Trail the remainder behind the 5m EMA20 or each new 1m higher ${side > 0 ? "low" : "high"}; final target T2 ${target2}${beyond ? ` (${beyond.label})` : " (3R)"}.`,
    "Time stop: if the trade is not at least +0.5R within 15 minutes, exit. Time decay works against a stalled option buy.",
    "Square off everything by 15:15 IST.",
  ];
  const action = confidence >= MIN_CONFIDENCE && !blockedBy.length ? (side > 0 ? "BUY_CE" : "BUY_PE") : "WAIT";
  return {
    action, confidence, alignment,
    headline: action === "WAIT"
      ? (blockedBy[0] ?? `${bias} setup with low confidence (${confidence}%): stand aside`)
      : `${bias === "BULLISH" ? "Buy CE" : "Buy PE"}: ${t15.trend === "UP" ? "15m uptrend" : "15m downtrend"} pullback with a 1m ${trigger1m?.name ?? "break of structure"}`,
    ...base,
    spot: spotPlan,
    trigger: trigger1m ? `${trigger1m.name} closed on 1m${microBreak ? ` and price broke ${side > 0 ? t1.swingHigh : t1.swingLow}` : ""}` : `1m close ${side > 0 ? "above" : "below"} ${side > 0 ? t1.swingHigh : t1.swingLow}`,
    invalidation: `A ${side > 0 ? "5m close below" : "5m close above"} ${spotPlan.stop}, or the 15m trend flipping`,
    reasons, risks, psychology: psychology.slice(0, 4), exitPlan, blockedBy,
  };
}

/** Compact form for the AI brief (keeps the prompt small). */
export function mtfBrief(decision: MtfDecision) {
  const tf = (read: TimeframeRead | null) => read && { trend: read.trend, score: read.score, structure: read.structure, close: read.close, ema20: read.ema20, ema50: read.ema50, rsi14: read.rsi14, atr14: read.atr14, vwap: read.vwap, swing_high: read.swingHigh, swing_low: read.swingLow, candles: read.patterns.map((pattern) => `${pattern.name} (${pattern.bias.toLowerCase()}, strength ${pattern.strength}${pattern.atLevel ? `, at ${pattern.atLevel}` : ""})`), notes: read.notes };
  return {
    engine_action: decision.action, engine_confidence: decision.confidence, alignment: decision.alignment, headline: decision.headline,
    timeframes: { "1D": tf(decision.timeframes["1D"]), "15m": tf(decision.timeframes["15m"]), "5m": tf(decision.timeframes["5m"]), "1m": tf(decision.timeframes["1m"]) },
    key_levels: decision.levels.map((level) => `${level.label} ${level.price} (${level.kind.toLowerCase()})`),
    plan: decision.spot, trigger: decision.trigger, option_value: Object.values(decision.valuation).map((value) => `${value!.side} ${value!.tradingSymbol}: ${value!.note}`),
    reasons: decision.reasons, risks: decision.risks,
  };
}
