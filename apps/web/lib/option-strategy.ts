// Index option strategy selector (NIFTY / BANKNIFTY / SENSEX).
//
// Decomposes every premium into intrinsic + extrinsic (time) value, measures how much time is
// left to expiry and how fast it is decaying, reads the volatility regime (India VIX / ATM IV),
// option-chain positioning (PCR, OI walls, max pain) and market sentiment, then scores a menu of
// defined-risk structures and builds the best fits with real strikes from the live chain.
// Analysis only: nothing here places orders and no structure carries naked short risk.

export type ChainRow = { contract: "CALL" | "PUT"; strike: number; premium: number; iv?: number; delta?: number; theta?: number; openInterest?: number; volume?: number; lotSize?: number };
export type SentimentInput = { indiaScore: number | null; globalScore: number | null; eventRisk: string[]; contrarianNote?: string | null };
export type TrendInput = { regime?: string | null; vwap?: number | null; ema20?: number | null; ema50?: number | null };
export type StrategyInput = { symbol: string; spot: number; expiry: string; chain: ChainRow[]; vix?: number | null; sentiment?: SentimentInput | null; trend?: TrendInput | null; lotSize?: number; now?: Date };

export type Phase = "EXPIRY_DAY" | "NEAR" | "MID" | "FAR";
export type IvRegime = "LOW" | "NORMAL" | "HIGH" | "EXTREME";
export type BiasLabel = "STRONGLY_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "STRONGLY_BEARISH";
export type OptionValueRow = { strike: number; type: "CE" | "PE"; premium: number; intrinsic: number; extrinsic: number; extrinsicPct: number; moneyness: "ITM" | "ATM" | "OTM"; iv: number | null; delta: number | null; theta: number | null };
export type Leg = { action: "BUY" | "SELL"; type: "CE" | "PE"; strike: number; premium: number; intrinsic: number; extrinsic: number; delta: number | null };
export type StrategyId = "LONG_CALL" | "LONG_PUT" | "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "IRON_CONDOR" | "IRON_BUTTERFLY" | "LONG_STRADDLE" | "LONG_STRANGLE";
export type StrategyPlan = {
  id: StrategyId; name: string; view: string; fit: number; kind: "DEBIT" | "CREDIT"; legs: Leg[];
  netPremium: number; maxProfit: number | null; maxLoss: number; breakevens: number[]; probabilityOfProfit: number | null;
  perLot: { premium: number; maxProfit: number | null; maxLoss: number }; netDelta: number | null; netTheta: number | null; netExtrinsic: number;
  rationale: string[]; exit: string[];
};
export type Factors = {
  symbol: string; spot: number; atmStrike: number; strikeStep: number; expiry: string; daysToExpiry: number; phase: Phase; lotSize: number;
  atmIv: number | null; vix: number | null; ivRegime: IvRegime; ivRichVsVix: boolean;
  straddle: number; atmExtrinsic: number; expectedMove: number; expectedMovePct: number; rangeLow: number; rangeHigh: number; thetaPerDay: number;
  pcr: number | null; maxPain: number | null; support: number | null; resistance: number | null; putSkew: number | null;
  bias: { score: number; label: BiasLabel; sentiment: number; global: number; trend: number; pcr: number };
  eventRisk: string[]; minutesToClose: number;
};
export type StrategyRecommendation = { verdict: "TRADE" | "WAIT"; headline: string; factors: Factors; primary: StrategyPlan | null; alternatives: StrategyPlan[]; notes: string[]; rows: OptionValueRow[] };

const DAY_MS = 86_400_000;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Risk-neutral probability that spot finishes above `level` at expiry (lognormal, r ≈ 0). */
export function probabilityAbove(spot: number, level: number, sigma: number, years: number): number {
  if (level <= 0) return 1;
  if (sigma <= 0 || years <= 0) return spot > level ? 1 : 0;
  const d2 = (Math.log(spot / level) - 0.5 * sigma * sigma * years) / (sigma * Math.sqrt(years));
  return normCdf(d2);
}

export const intrinsicValue = (type: "CE" | "PE", strike: number, spot: number) => Math.max(0, type === "CE" ? spot - strike : strike - spot);

/** Expiry settles at 15:30 IST (10:00 UTC) on the expiry date. */
export function timeToExpiry(expiry: string, now: Date) {
  const close = Date.parse(`${expiry}T10:00:00Z`);
  const ms = Number.isFinite(close) ? Math.max(close - now.getTime(), 0) : 0;
  const istToday = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const days = ms / DAY_MS;
  const phase: Phase = istToday >= expiry ? "EXPIRY_DAY" : days <= 2.5 ? "NEAR" : days <= 7.5 ? "MID" : "FAR";
  // Floor at 15 minutes so sigma*sqrt(T) never collapses to zero in the last minutes.
  return { days, years: Math.max(ms, 15 * 60_000) / (365 * DAY_MS), phase, minutesToClose: ms / 60_000 };
}

export function classifyIv(value: number | null): IvRegime {
  if (value === null) return "NORMAL";
  return value < 12 ? "LOW" : value < 16.5 ? "NORMAL" : value < 22 ? "HIGH" : "EXTREME";
}

export function biasLabel(score: number): BiasLabel {
  return score >= 45 ? "STRONGLY_BULLISH" : score >= 15 ? "BULLISH" : score > -15 ? "NEUTRAL" : score > -45 ? "BEARISH" : "STRONGLY_BEARISH";
}

export function computeBias(input: { sentiment?: SentimentInput | null; trend?: TrendInput | null; spot: number; pcr: number | null }) {
  const india = finite(input.sentiment?.indiaScore);
  const global = finite(input.sentiment?.globalScore);
  // Crowd extremes are contrarian: halve the weight of a one-sided retail/news reading.
  const sentiment = india === null ? 0 : clamp(india, -100, 100) * 0.35 * (Math.abs(india) > 70 ? 0.5 : 1);
  const globalPart = global === null ? 0 : clamp(global, -100, 100) * 0.15;
  let trendScore = 0;
  const regime = String(input.trend?.regime ?? "").toUpperCase();
  if (/BULL|UP/.test(regime)) trendScore += 50; else if (/BEAR|DOWN/.test(regime)) trendScore -= 50;
  const vwap = finite(input.trend?.vwap); const ema20 = finite(input.trend?.ema20); const ema50 = finite(input.trend?.ema50);
  if (vwap && input.spot > 0) trendScore += input.spot > vwap ? 25 : -25;
  if (ema20 && ema50) trendScore += ema20 > ema50 ? 25 : -25;
  const trend = trendScore * 0.3;
  let pcrPart = 0;
  if (input.pcr !== null) {
    // Put writing (PCR > 1) is support underneath; extreme readings are crowded and fade.
    const extreme = input.pcr > 1.7 || input.pcr < 0.5;
    pcrPart = clamp((input.pcr - 1) * 100, -60, 60) * 0.2 * (extreme ? 0.5 : 1);
  }
  const score = Math.round(clamp(sentiment + globalPart + trend + pcrPart, -100, 100));
  return { score, label: biasLabel(score), sentiment: round2(sentiment), global: round2(globalPart), trend: round2(trend), pcr: round2(pcrPart) };
}

type Book = { strikes: number[]; step: number; ce: Map<number, ChainRow>; pe: Map<number, ChainRow> };

function buildBook(chain: ChainRow[]): Book {
  const ce = new Map<number, ChainRow>(); const pe = new Map<number, ChainRow>();
  for (const row of chain) {
    if (!(row.premium > 0) || !(row.strike > 0)) continue;
    (row.contract === "CALL" ? ce : pe).set(row.strike, row);
  }
  const strikes = [...new Set([...ce.keys(), ...pe.keys()])].sort((a, b) => a - b);
  let step = Infinity;
  for (let index = 1; index < strikes.length; index += 1) step = Math.min(step, strikes[index] - strikes[index - 1]);
  return { strikes, step: Number.isFinite(step) ? step : 50, ce, pe };
}

function nearestStrike(book: Book, type: "CE" | "PE", target: number, filter: (strike: number) => boolean = () => true): number | null {
  const side = type === "CE" ? book.ce : book.pe;
  let best: number | null = null;
  for (const strike of side.keys()) if (filter(strike) && (best === null || Math.abs(strike - target) < Math.abs(best - target))) best = strike;
  return best;
}

function maxPainOf(book: Book): number | null {
  let best: number | null = null; let bestPain = Infinity;
  for (const settle of book.strikes) {
    let pain = 0;
    for (const [strike, row] of book.ce) pain += Math.max(0, settle - strike) * (row.openInterest ?? 0);
    for (const [strike, row] of book.pe) pain += Math.max(0, strike - settle) * (row.openInterest ?? 0);
    if (pain < bestPain) { bestPain = pain; best = settle; }
  }
  return bestPain > 0 || best === null ? best : null;
}

function wall(side: Map<number, ChainRow>, accept: (strike: number) => boolean): number | null {
  let best: number | null = null; let oi = 0;
  for (const [strike, row] of side) if (accept(strike) && (row.openInterest ?? 0) > oi) { oi = row.openInterest ?? 0; best = strike; }
  return best;
}

function legFrom(book: Book, action: Leg["action"], type: Leg["type"], strike: number | null, spot: number): Leg | null {
  if (strike === null) return null;
  const row = (type === "CE" ? book.ce : book.pe).get(strike);
  if (!row) return null;
  const intrinsic = intrinsicValue(type, strike, spot);
  return { action, type, strike, premium: row.premium, intrinsic: round2(intrinsic), extrinsic: round2(Math.max(0, row.premium - intrinsic)), delta: finite(row.delta) };
}

/** Expiry payoff per unit of underlying (premium included). */
export function payoffAt(legs: Leg[], settle: number): number {
  return legs.reduce((sum, leg) => sum + (leg.action === "BUY" ? 1 : -1) * (intrinsicValue(leg.type, leg.strike, settle) - leg.premium), 0);
}

export function analysePayoff(legs: Leg[], spot: number, sigma: number, years: number) {
  const points = [...new Set([0, ...legs.map((leg) => leg.strike), spot * 3])].sort((a, b) => a - b);
  const values = points.map((point) => payoffAt(legs, point));
  const rightSlope = legs.reduce((sum, leg) => sum + (leg.type === "CE" ? (leg.action === "BUY" ? 1 : -1) : 0), 0);
  const maxProfit = rightSlope > 0 ? null : Math.max(...values);
  const maxLoss = Math.max(0, -Math.min(...values));
  const breakevens: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const [a, b] = [values[index - 1], values[index]];
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) breakevens.push(points[index - 1] + (points[index] - points[index - 1]) * (a / (a - b)));
  }
  const edges = [0, ...breakevens, Infinity];
  let pop = 0;
  for (let index = 1; index < edges.length; index += 1) {
    const low = edges[index - 1]; const high = edges[index];
    const probe = Number.isFinite(high) ? (low + high) / 2 : Math.max(low, spot) * 1.5 + 1;
    if (payoffAt(legs, probe) > 0) pop += probabilityAbove(spot, low, sigma, years) - (Number.isFinite(high) ? probabilityAbove(spot, high, sigma, years) : 0);
  }
  return { maxProfit: maxProfit === null ? null : round2(maxProfit), maxLoss: round2(maxLoss), breakevens: breakevens.map((value) => round2(value)), probabilityOfProfit: sigma > 0 ? round2(clamp(pop, 0, 1) * 100) : null };
}

type Template = { id: StrategyId; name: string; view: string; family: "LONG_SINGLE" | "DEBIT_SPREAD" | "CREDIT_SPREAD" | "CONDOR" | "FLY" | "LONG_VOL"; direction: 1 | -1 | 0 };
const TEMPLATES: Template[] = [
  { id: "LONG_CALL", name: "Long Call", view: "Strong bullish, cheap volatility", family: "LONG_SINGLE", direction: 1 },
  { id: "LONG_PUT", name: "Long Put", view: "Strong bearish, cheap volatility", family: "LONG_SINGLE", direction: -1 },
  { id: "BULL_CALL_SPREAD", name: "Bull Call Spread", view: "Bullish to the expected-move target", family: "DEBIT_SPREAD", direction: 1 },
  { id: "BEAR_PUT_SPREAD", name: "Bear Put Spread", view: "Bearish to the expected-move target", family: "DEBIT_SPREAD", direction: -1 },
  { id: "BULL_PUT_SPREAD", name: "Bull Put Spread (credit)", view: "Mildly bullish / support holds", family: "CREDIT_SPREAD", direction: 1 },
  { id: "BEAR_CALL_SPREAD", name: "Bear Call Spread (credit)", view: "Mildly bearish / resistance caps", family: "CREDIT_SPREAD", direction: -1 },
  { id: "IRON_CONDOR", name: "Iron Condor", view: "Range-bound inside the expected move", family: "CONDOR", direction: 0 },
  { id: "IRON_BUTTERFLY", name: "Iron Butterfly", view: "Pinned near ATM / max pain", family: "FLY", direction: 0 },
  { id: "LONG_STRADDLE", name: "Long Straddle", view: "Big move either way (event)", family: "LONG_VOL", direction: 0 },
  { id: "LONG_STRANGLE", name: "Long Strangle", view: "Large breakout either way, cheaper", family: "LONG_VOL", direction: 0 },
];

const VOL_FIT: Record<Template["family"], Record<IvRegime, number>> = {
  LONG_SINGLE: { LOW: 15, NORMAL: 0, HIGH: -15, EXTREME: -25 },
  LONG_VOL: { LOW: 15, NORMAL: 0, HIGH: -15, EXTREME: -20 },
  DEBIT_SPREAD: { LOW: 5, NORMAL: 5, HIGH: 0, EXTREME: -5 },
  CREDIT_SPREAD: { LOW: -15, NORMAL: 5, HIGH: 15, EXTREME: 10 },
  CONDOR: { LOW: -15, NORMAL: 5, HIGH: 15, EXTREME: 5 },
  FLY: { LOW: -15, NORMAL: 0, HIGH: 10, EXTREME: 0 },
};
const TIME_FIT: Record<Template["family"], Record<Phase, number>> = {
  LONG_SINGLE: { FAR: 5, MID: 5, NEAR: -5, EXPIRY_DAY: -10 },
  LONG_VOL: { FAR: 5, MID: 0, NEAR: -15, EXPIRY_DAY: -30 },
  DEBIT_SPREAD: { FAR: 10, MID: 5, NEAR: 0, EXPIRY_DAY: -5 },
  CREDIT_SPREAD: { FAR: -5, MID: 5, NEAR: 10, EXPIRY_DAY: 5 },
  CONDOR: { FAR: -5, MID: 5, NEAR: 10, EXPIRY_DAY: 5 },
  FLY: { FAR: -10, MID: 0, NEAR: 5, EXPIRY_DAY: -5 },
};
const EVENT_FIT: Record<Template["family"], number> = { LONG_SINGLE: 5, LONG_VOL: 20, DEBIT_SPREAD: 0, CREDIT_SPREAD: -15, CONDOR: -20, FLY: -25 };
const LONG_PREMIUM = new Set<Template["family"]>(["LONG_SINGLE", "LONG_VOL"]);
const SHORT_PREMIUM = new Set<Template["family"]>(["CREDIT_SPREAD", "CONDOR", "FLY"]);

function scoreTemplate(template: Template, factors: Factors, event: boolean): number {
  const b = factors.bias.score;
  const signed = b * template.direction;
  let direction = 0;
  if (template.family === "LONG_SINGLE") direction = clamp((signed - 40) * 0.6, -40, 25);
  else if (template.family === "DEBIT_SPREAD") direction = clamp((signed - 20) * 0.6, -40, 25);
  else if (template.family === "CREDIT_SPREAD") direction = clamp((signed - 10) * 0.6, -40, 20);
  else if (template.family === "CONDOR") direction = clamp((25 - Math.abs(b)) * 0.8, -40, 20);
  else if (template.family === "FLY") direction = clamp((15 - Math.abs(b)) * 1.0, -40, 20);
  let fit = 50 + direction + VOL_FIT[template.family][factors.ivRegime] + TIME_FIT[template.family][factors.phase];
  fit += event ? EVENT_FIT[template.family] : template.family === "LONG_VOL" ? -15 : 0;
  if (factors.ivRichVsVix) fit += SHORT_PREMIUM.has(template.family) ? 5 : LONG_PREMIUM.has(template.family) ? -5 : 0;
  // Last 2 hours of expiry: premium buyers fight brutal theta; sellers face gamma on short strikes.
  if (factors.phase === "EXPIRY_DAY" && factors.minutesToClose < 120) fit += LONG_PREMIUM.has(template.family) ? -15 : template.family === "FLY" ? -10 : 0;
  return Math.round(clamp(fit, 0, 100));
}

function buildLegs(id: StrategyId, book: Book, f: Factors): Leg[] | null {
  const { spot, atmStrike: atm, strikeStep: step, expectedMove: em } = f;
  const near = f.phase === "NEAR" || f.phase === "EXPIRY_DAY";
  const wing = Math.max(step * 2, Math.round((em * 0.5) / step) * step);
  const L = (action: Leg["action"], type: Leg["type"], strike: number | null) => legFrom(book, action, type, strike, spot);
  // Credit short strikes sit about 0.8 expected moves out, or at the OI wall if it is farther.
  const shortPut = () => { const base = spot - Math.max(em * 0.8, step); const wallStrike = f.support !== null && f.support < base ? f.support : null; return nearestStrike(book, "PE", wallStrike ?? base, (k) => k < spot); };
  const shortCall = () => { const base = spot + Math.max(em * 0.8, step); const wallStrike = f.resistance !== null && f.resistance > base ? f.resistance : null; return nearestStrike(book, "CE", wallStrike ?? base, (k) => k > spot); };
  let legs: Array<Leg | null>;
  switch (id) {
    // Near expiry, buy one strike in the money: more intrinsic, less decaying extrinsic.
    case "LONG_CALL": legs = [L("BUY", "CE", nearestStrike(book, "CE", near ? atm - step : atm))]; break;
    case "LONG_PUT": legs = [L("BUY", "PE", nearestStrike(book, "PE", near ? atm + step : atm))]; break;
    case "BULL_CALL_SPREAD": legs = [L("BUY", "CE", atm), L("SELL", "CE", nearestStrike(book, "CE", atm + Math.max(em, step), (k) => k > atm))]; break;
    case "BEAR_PUT_SPREAD": legs = [L("BUY", "PE", atm), L("SELL", "PE", nearestStrike(book, "PE", atm - Math.max(em, step), (k) => k < atm))]; break;
    case "BULL_PUT_SPREAD": { const s = shortPut(); legs = [L("SELL", "PE", s), L("BUY", "PE", s === null ? null : nearestStrike(book, "PE", s - wing, (k) => k < s))]; break; }
    case "BEAR_CALL_SPREAD": { const s = shortCall(); legs = [L("SELL", "CE", s), L("BUY", "CE", s === null ? null : nearestStrike(book, "CE", s + wing, (k) => k > s))]; break; }
    case "IRON_CONDOR": {
      const sp = shortPut(); const sc = shortCall();
      legs = [L("BUY", "PE", sp === null ? null : nearestStrike(book, "PE", sp - wing, (k) => k < sp)), L("SELL", "PE", sp), L("SELL", "CE", sc), L("BUY", "CE", sc === null ? null : nearestStrike(book, "CE", sc + wing, (k) => k > sc))];
      break;
    }
    case "IRON_BUTTERFLY": legs = [L("BUY", "PE", nearestStrike(book, "PE", atm - Math.max(em, step * 2), (k) => k < atm)), L("SELL", "PE", atm), L("SELL", "CE", atm), L("BUY", "CE", nearestStrike(book, "CE", atm + Math.max(em, step * 2), (k) => k > atm))]; break;
    case "LONG_STRADDLE": legs = [L("BUY", "CE", atm), L("BUY", "PE", atm)]; break;
    case "LONG_STRANGLE": legs = [L("BUY", "PE", nearestStrike(book, "PE", atm - Math.max(em * 0.5, step), (k) => k < atm)), L("BUY", "CE", nearestStrike(book, "CE", atm + Math.max(em * 0.5, step), (k) => k > atm))]; break;
  }
  if (legs.some((leg) => leg === null)) return null;
  const strikes = new Set(legs.map((leg) => `${leg!.type}${leg!.strike}`));
  return strikes.size === legs.length ? (legs as Leg[]) : null;
}

function describe(template: Template, f: Factors, plan: Omit<StrategyPlan, "rationale" | "exit">): { rationale: string[]; exit: string[] } {
  const rationale: string[] = [];
  const exit: string[] = [];
  const biasText = `Bias ${f.bias.score > 0 ? "+" : ""}${f.bias.score} (${f.bias.label.replaceAll("_", " ").toLowerCase()})`;
  const ivText = `IV ${f.ivRegime.toLowerCase()}${f.vix !== null ? ` (VIX ${fmt(f.vix)})` : f.atmIv !== null ? ` (ATM IV ${fmt(f.atmIv)})` : ""}`;
  const timeText = f.phase === "EXPIRY_DAY" ? "expiry day: extrinsic collapses to zero by 15:30" : `${fmt(round2(f.daysToExpiry))} days to expiry, ATM straddle bleeds ≈ ₹${fmt(f.thetaPerDay)}/day`;
  const net = plan.netPremium;
  const paid = plan.legs.filter((leg) => leg.action === "BUY").reduce((sum, leg) => sum + leg.extrinsic, 0);
  const sold = plan.legs.filter((leg) => leg.action === "SELL").reduce((sum, leg) => sum + leg.extrinsic, 0);
  switch (template.family) {
    case "LONG_SINGLE": {
      const leg = plan.legs[0];
      rationale.push(`${biasText} justifies an outright ${leg.type === "CE" ? "call" : "put"}; ${ivText} keeps the premium affordable.`);
      rationale.push(`Premium ₹${fmt(leg.premium)} = intrinsic ₹${fmt(leg.intrinsic)} + time value ₹${fmt(leg.extrinsic)}${leg.intrinsic > 0 ? " — buying in the money so most of what you pay is real value, not decaying time." : " — all of it is time value, so the move must come quickly."}`);
      rationale.push(`Spot needs to clear ${fmt(plan.breakevens[0] ?? leg.strike)} by expiry; ${timeText}.`);
      const delta = Math.abs(leg.delta ?? 0.5) || 0.5;
      exit.push(`Stop: premium ₹${fmt(round2(leg.premium * 0.65))} (−35%) or a 15-minute close back through VWAP.`);
      exit.push(`Target: ₹${fmt(round2(leg.premium + delta * f.expectedMove * 0.8))} (≈ 0.8 × expected move of ${fmt(f.expectedMove)} pts); trail the stop to cost once +20%.`);
      exit.push(f.phase === "EXPIRY_DAY" || f.phase === "NEAR" ? "Time stop: exit if the move has not started within 45 minutes — theta is steepest now." : "Time stop: exit if still flat with 2 days to expiry; theta accelerates in the last 48 hours.");
      break;
    }
    case "DEBIT_SPREAD": {
      rationale.push(`${biasText}; the spread targets the expected move (±${fmt(f.expectedMove)} pts) instead of an open-ended run.`);
      rationale.push(`Selling the farther strike recovers ₹${fmt(round2(sold))} of the ₹${fmt(round2(paid))} time value paid, cutting theta and IV crush (${ivText}).`);
      rationale.push(`Risk ₹${fmt(plan.maxLoss)} to make ₹${fmt(plan.maxProfit ?? 0)} per unit (${fmt(round2((plan.maxProfit ?? 0) / Math.max(plan.maxLoss, 0.01)))} : 1).`);
      exit.push(`Target: close at 65–70% of max value (spread worth ≈ ₹${fmt(round2(net + (plan.maxProfit ?? 0) * 0.65))}).`);
      exit.push(`Stop: spread value falls to ₹${fmt(round2(net * 0.5))} (−50% of debit) or the trend view is invalidated.`);
      break;
    }
    case "CREDIT_SPREAD": {
      const short = plan.legs.find((leg) => leg.action === "SELL")!;
      rationale.push(`${biasText}; profits if spot merely stays ${short.type === "PE" ? "above" : "below"} ${fmt(short.strike)}${(short.type === "PE" ? f.support : f.resistance) === short.strike ? " — the largest OI wall" : ""}, ≈ ${fmt(Math.abs(short.strike - f.spot))} pts away.`);
      rationale.push(`Collects ₹${fmt(-net)} of time value; ${ivText}${f.ivRegime === "HIGH" || f.ivRegime === "EXTREME" ? " makes that extrinsic rich" : ""}, and ${timeText}.`);
      rationale.push(`Defined risk: the long wing caps the loss at ₹${fmt(plan.maxLoss)} per unit — no naked selling.`);
      exit.push(`Take profit: buy back at ₹${fmt(round2(-net * 0.5))} (50% of credit).`);
      exit.push(`Stop: spread costs ₹${fmt(round2(-net * 2))} (2× credit) or spot closes 15 minutes beyond ${fmt(short.strike)}.`);
      break;
    }
    case "CONDOR":
    case "FLY": {
      rationale.push(`${biasText}: no directional edge; expected range ${fmt(f.rangeLow)}–${fmt(f.rangeHigh)}${f.maxPain !== null ? `, max pain ${fmt(f.maxPain)}` : ""}.`);
      rationale.push(`Sells ₹${fmt(round2(sold))} of time value against ₹${fmt(round2(paid))} bought; ${ivText}; ${timeText}.`);
      rationale.push(template.family === "FLY" ? "Butterfly collects the most premium but needs spot to pin near the centre strike." : `Short strikes sit outside the 1σ move or at the OI walls (support ${f.support !== null ? fmt(f.support) : "--"}, resistance ${f.resistance !== null ? fmt(f.resistance) : "--"}).`);
      exit.push(`Take profit: close at ${template.family === "FLY" ? "25–30%" : "50%"} of the ₹${fmt(-net)} credit.`);
      exit.push(`Adjust/exit if spot touches a short strike, or if the position loses ₹${fmt(round2(-net * 1.5))} (1.5× credit).`);
      break;
    }
    case "LONG_VOL": {
      rationale.push(f.eventRisk.length ? `Event risk ahead (${f.eventRisk.slice(0, 3).join(", ")}): a large move in either direction is more likely than priced.` : "Volatility is cheap with no clear direction; positioned for a breakout either way.");
      rationale.push(`Pays ₹${fmt(net)} — almost all time value; ${ivText}. Needs a move beyond ${plan.breakevens.map(fmt).join(" / ")}.`);
      rationale.push(`Market prices ±${fmt(f.expectedMove)} pts to expiry (${fmt(f.expectedMovePct)}%).`);
      exit.push(`Target: +40% on combined premium, or exit right after the event (IV crush hits both legs).`);
      exit.push(`Stop: −25% of premium or no move within one session; ${timeText}.`);
      break;
    }
  }
  if (f.phase === "EXPIRY_DAY") exit.push("Square off by 15:00 IST — no positions into settlement.");
  return { rationale, exit };
}

export function buildOptionStrategy(input: StrategyInput): StrategyRecommendation {
  const now = input.now ?? new Date();
  const book = buildBook(input.chain);
  const spot = input.spot;
  const notes: string[] = [];
  const time = timeToExpiry(input.expiry, now);
  const pairStrikes = book.strikes.filter((strike) => book.ce.has(strike) && book.pe.has(strike));
  const atmStrike = (pairStrikes.length ? pairStrikes : book.strikes).reduce((best, strike) => (Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best), book.strikes[0] ?? Math.round(spot));
  const atmCe = book.ce.get(atmStrike); const atmPe = book.pe.get(atmStrike);
  const ivs = [atmCe?.iv, atmPe?.iv].map(finite).filter((value): value is number => value !== null && value > 0);
  const atmIv = ivs.length ? round2(ivs.reduce((a, b) => a + b, 0) / ivs.length) : null;
  const vix = finite(input.vix) && (input.vix as number) > 0 ? round2(input.vix as number) : null;
  const sigma = (atmIv ?? vix ?? 14) / 100;
  const straddle = round2((atmCe?.premium ?? 0) + (atmPe?.premium ?? 0));
  const atmExtrinsic = round2(straddle - Math.abs(spot - atmStrike));
  // ≈0.8 × ATM straddle is the market's 1σ move; fall back to the IV-implied move.
  const ivMove = spot * sigma * Math.sqrt(time.years);
  const expectedMove = round2(straddle > 0 ? straddle * 0.8 : ivMove);
  const thetas = [atmCe?.theta, atmPe?.theta].map(finite).filter((value): value is number => value !== null && value !== 0);
  const thetaPerDay = round2(thetas.length === 2 ? Math.abs(thetas[0]) + Math.abs(thetas[1]) : atmExtrinsic / (2 * Math.max(time.days, 0.25)));
  const ceOi = [...book.ce.values()].reduce((sum, row) => sum + (row.openInterest ?? 0), 0);
  const peOi = [...book.pe.values()].reduce((sum, row) => sum + (row.openInterest ?? 0), 0);
  const pcr = ceOi > 0 ? round2(peOi / ceOi) : null;
  const otmPut = book.pe.get(nearestStrike(book, "PE", spot - expectedMove, (k) => k < spot) ?? -1);
  const otmCall = book.ce.get(nearestStrike(book, "CE", spot + expectedMove, (k) => k > spot) ?? -1);
  const putSkew = otmPut?.iv && otmCall?.iv ? round2(otmPut.iv - otmCall.iv) : null;
  const ivForRegime = vix ?? atmIv;
  const lotSize = input.lotSize ?? input.chain.find((row) => (row.lotSize ?? 0) > 0)?.lotSize ?? 1;

  const factors: Factors = {
    symbol: input.symbol, spot: round2(spot), atmStrike, strikeStep: book.step, expiry: input.expiry, daysToExpiry: round2(time.days), phase: time.phase, lotSize,
    atmIv, vix, ivRegime: classifyIv(ivForRegime), ivRichVsVix: atmIv !== null && vix !== null && input.symbol === "NIFTY" && atmIv > vix * 1.15,
    straddle, atmExtrinsic, expectedMove, expectedMovePct: spot > 0 ? round2((expectedMove / spot) * 100) : 0, rangeLow: round2(spot - expectedMove), rangeHigh: round2(spot + expectedMove), thetaPerDay,
    pcr, maxPain: maxPainOf(book), support: wall(book.pe, (k) => k < spot), resistance: wall(book.ce, (k) => k > spot), putSkew,
    bias: computeBias({ sentiment: input.sentiment, trend: input.trend, spot, pcr }),
    eventRisk: input.sentiment?.eventRisk ?? [], minutesToClose: Math.round(time.minutesToClose),
  };

  const rows: OptionValueRow[] = book.strikes
    .filter((strike) => Math.abs(strike - atmStrike) <= book.step * 4)
    .flatMap((strike) => (["CE", "PE"] as const).flatMap((type) => {
      const row = (type === "CE" ? book.ce : book.pe).get(strike);
      if (!row) return [];
      const intrinsic = intrinsicValue(type, strike, spot);
      const extrinsic = Math.max(0, row.premium - intrinsic);
      return [{ strike, type, premium: row.premium, intrinsic: round2(intrinsic), extrinsic: round2(extrinsic), extrinsicPct: round2((extrinsic / row.premium) * 100), moneyness: strike === atmStrike ? "ATM" : intrinsic > 0 ? "ITM" : "OTM", iv: finite(row.iv), delta: finite(row.delta), theta: finite(row.theta) } satisfies OptionValueRow];
    }));

  if (!(spot > 0) || !atmCe || !atmPe) {
    return { verdict: "WAIT", headline: "Waiting for a live option chain with ATM calls and puts.", factors, primary: null, alternatives: [], notes: ["Strategy needs spot, an ATM CE and an ATM PE premium."], rows };
  }

  const event = factors.eventRisk.length > 0;
  const plans: StrategyPlan[] = [];
  for (const template of TEMPLATES) {
    const legs = buildLegs(template.id, book, factors);
    if (!legs) continue;
    const netPremium = round2(legs.reduce((sum, leg) => sum + (leg.action === "BUY" ? leg.premium : -leg.premium), 0));
    const payoff = analysePayoff(legs, spot, sigma, time.years);
    if (payoff.maxProfit !== null && payoff.maxProfit <= 0) continue;
    const deltas = legs.map((leg) => leg.delta);
    const netDelta = deltas.every((value) => value !== null) ? round2(legs.reduce((sum, leg) => sum + (leg.action === "BUY" ? 1 : -1) * (leg.delta as number), 0)) : null;
    const thetaRows = legs.map((leg) => finite((leg.type === "CE" ? book.ce : book.pe).get(leg.strike)?.theta));
    const netTheta = thetaRows.every((value) => value !== null) ? round2(legs.reduce((sum, leg, index) => sum + (leg.action === "BUY" ? 1 : -1) * (thetaRows[index] as number), 0)) : null;
    const netExtrinsic = round2(legs.reduce((sum, leg) => sum + (leg.action === "BUY" ? 1 : -1) * leg.extrinsic, 0));
    const base = {
      id: template.id, name: template.name, view: template.view, fit: scoreTemplate(template, factors, event), kind: netPremium >= 0 ? "DEBIT" as const : "CREDIT" as const, legs, netPremium, ...payoff,
      perLot: { premium: round2(netPremium * lotSize), maxProfit: payoff.maxProfit === null ? null : round2(payoff.maxProfit * lotSize), maxLoss: round2(payoff.maxLoss * lotSize) }, netDelta, netTheta, netExtrinsic,
    };
    plans.push({ ...base, ...describe(template, factors, base) });
  }
  plans.sort((a, b) => b.fit - a.fit || (b.probabilityOfProfit ?? 0) - (a.probabilityOfProfit ?? 0));

  if (event) notes.push(`Event risk flagged by news (${factors.eventRisk.slice(0, 3).join(", ")}): short-premium structures are penalised.`);
  if (input.sentiment?.contrarianNote) notes.push(input.sentiment.contrarianNote);
  if (factors.ivRegime === "EXTREME") notes.push("Volatility is extreme: halve position size and keep every structure defined-risk.");
  if (factors.phase === "EXPIRY_DAY") notes.push("Expiry day: gamma is at its peak — small moves swing premiums hard. Size down.");
  if (factors.maxPain !== null && (factors.phase === "EXPIRY_DAY" || factors.phase === "NEAR") && Math.abs(factors.maxPain - spot) > expectedMove) notes.push(`Spot is ${fmt(Math.abs(round2(factors.maxPain - spot)))} pts from max pain ${fmt(factors.maxPain)} — expect writers to defend levels near expiry.`);
  if (factors.putSkew !== null && factors.putSkew > 3) notes.push(`Put skew +${fmt(factors.putSkew)} IV pts: downside protection is expensive (fear is priced in).`);

  const lateExpiry = factors.phase === "EXPIRY_DAY" && factors.minutesToClose < 60;
  const primary = plans[0] ?? null;
  const verdict = primary && primary.fit >= 60 && !lateExpiry ? "TRADE" : "WAIT";
  const headline = lateExpiry
    ? "Final hour of expiry — no fresh positions; let existing trades settle or square off."
    : verdict === "TRADE" && primary
      ? `${primary.name}: ${primary.view.toLowerCase()} (fit ${primary.fit}/100).`
      : `No structure scores ≥ 60 — the factors conflict. Stay flat${primary ? `; best fit is ${primary.name} at ${primary.fit}/100` : ""}.`;
  return { verdict, headline, factors, primary, alternatives: plans.slice(1, 4), notes, rows };
}
