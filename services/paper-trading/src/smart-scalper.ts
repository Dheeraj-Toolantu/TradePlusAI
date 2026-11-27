import { getActiveOrdersFromFirestore, saveOrderToFirestore, type OrderRecord } from "../../../apps/web/lib/firestore-orders";
import { DEFAULT_MONEY_TRAIL, SNIPER_TRAIL, TRAIL_MODES, VWAP_EMA_TRAIL, moneyTrailError, moneyTrailPrices, smartTrail, sniperTrail, type MoneyTrailConfig, type TrailMode } from "./scalper-trail";
import { isCommodity, sessionFor } from "../../../apps/web/lib/underlyings";

/**
 * Smart scalper (paper only).
 *
 * Every scan reads the underlying's 1-minute tape and decides, by itself, between:
 *  - SCALP: a single CE or PE buy, taken only when price is AT a support (CE) or resistance
 *    (PE: index resistance is where the put premium sits on its own support), a rejection
 *    candle confirms the level, and the next opposing level leaves at least `minRiskReward`.
 *    The stop sits just beyond the level, so the risk is the smallest the structure allows.
 *  - HEDGE: a debit spread (buy the ITM leg that is mostly intrinsic value, sell the OTM leg at
 *    the target that is pure time value). Chosen when the tape is volatile, implied volatility
 *    is rich, or it is expiry afternoon: the short leg pays for the long leg's time value and
 *    theta, and the risk is capped at the net debit. Only taken inside its own time window.
 *  - WAIT: no edge, outside the entry window, or the daily risk limits are hit.
 *
 * Naked option writing is never done; a SELL leg only exists inside a hedge.
 */

export type ScalperBar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ScalperContract = {
  symbol: string;
  contract: "CALL" | "PUT";
  expiry: string;
  strike: number;
  premium: number;
  bid: number;
  ask: number;
  openInterest: number;
  volume: number;
  iv: number;
  delta: number;
  theta: number;
  lotSize: number;
  tickSize: number;
};
export type ScalperMode = "AUTO" | "SCALP" | "HEDGE";
export type ScalperSettings = {
  /** New engine entries per day. */
  maxTrades: number;
  /** ₹ risk allowed per entry; also a hard exit for any position. */
  maxLossPerTrade: number;
  /** ₹ realised loss after which no new entries are taken today. */
  maxDailyLoss: number;
  /** Upper bound on lots per entry (risk can size it down, never up). */
  lots: number;
  minRiskReward: number;
  mode: ScalperMode;
  /** Scalps that have not reached +0.5R after this many minutes are closed. */
  maxHoldMinutes: number;
  /** New engine trades start on the smart auto trail (true) or only their strategy's own rule (false). */
  smartTrail: boolean;
  /** Smart trail: on the target, lock most of the move and let the trade run instead of closing it. */
  runPastTarget: boolean;
  /** NIFTY Sniper: the most lots per trade (1-10); half are booked at 1.5x with 2+ lots. */
  sniperLots: number;
  /** NIFTY Sniper V2 sizing: from the ₹ risk budget capped by sniperLots (RISK_BUDGET), or exactly sniperLots (FIXED_LOTS). */
  sniperSizing: "RISK_BUDGET" | "FIXED_LOTS";
  /** NIFTY Sniper setups switched on: A reversal, B breakout, C continuation (e.g. "ABC"). */
  sniperSetups: string;
  /** Rupee P&L stop and trail for new trades (e.g. −₹500 stop; at +₹500 to −₹200; +₹200 per ₹200; exit at the ₹ target). */
  moneyTrail: MoneyTrailConfig & { enabled: boolean };
};
export type Level = { price: number; touches: number; sources: string[] };
export type ExtraZone = { side: "DEMAND" | "SUPPLY"; low: number; high: number; sources?: string[] };
export type MarketRead = {
  trend: "UP" | "DOWN" | "FLAT";
  regime: "TRENDING" | "RANGING" | "VOLATILE";
  efficiency: number;
  ema9: number;
  ema21: number;
  vwap: number;
  atr: number;
  atrRatio: number;
  rsi: number;
  close: number;
  supports: Level[];
  resistances: Level[];
};
export type Gate = { label: string; passed: boolean };
export type SpotSetup = { side: "CE" | "PE"; level: Level; entry: number; stop: number; target: number; riskReward: number; gates: Gate[]; ready: boolean };
export type Valuation = { symbol: string; strike: number; premium: number; intrinsic: number; timeValue: number; intrinsicPct: number; moneyness: string; delta: number; theta: number };
export type ScalperPlan = {
  kind: "SCALP" | "HEDGE";
  side: "CE" | "PE";
  legs: Array<{ symbol: string; contract: "CALL" | "PUT"; strike: number; side: "BUY" | "SELL"; price: number; valuation: Valuation }>;
  lots: number;
  quantity: number;
  /** Net premium per unit (debit for a hedge). */
  entry: number;
  stop: number;
  target: number;
  riskPerLot: number;
  rewardPerLot: number;
  riskReward: number;
  spot: { entry: number; stop: number; target: number };
  reason: string;
  /** A systematic trailing rule for the position (the VWAP-EMA scalper's staged trail). */
  trail?: { rule: TrailRule; costPerUnit: number };
  /** What confirmed the entry (the VWAP-EMA scalper: ADX on the confirmation candle). */
  signal?: EntrySignal;
  /**
   * Re-plan on the actual fill (VWAP-EMA plans). The stop stays at its structural price; the fill
   * must not exceed maxEntry; the target is re-derived from the fill (fill + k·R, k = plan.riskReward)
   * but never beyond maxTarget (the OI wall); the R:R at the fill must still reach minRiskReward;
   * lots are re-sized so the STRESSED loss (fill − stop + exit slippage at the stop + stopGap, plus
   * fees) fits the max loss per trade.
   */
  risk?: {
    maxEntry: number; maxTarget: number; minRiskReward: number; stopGap: number; feesAtStopPerLot: number; lotSize: number;
    /**
     * NIFTY Sniper AI: the stop and target are fixed MULTIPLES of the actual average fill (spec 12.1),
     * e.g. { stop: 0.75, target: 2.0 }; they replace the structural stop and the k·R target.
     */
    premiumMultiples?: { stop: number; target: number; partial?: number };
    /** The trader chose the lots (NIFTY Sniper): place exactly this many, not sized down to the ₹ max loss. */
    fixedLots?: number;
  };
};
/** Systematic trailing rules: the VWAP-EMA scalper's R-based trail, NIFTY Sniper AI's premium-multiple trail. */
export type TrailRule = "VWAP_EMA" | "SNIPER";
/** Trend strength on the confirmation candle that triggered a VWAP-EMA entry. */
export type EntrySignal = { adx: number; plusDi: number; minusDi: number; rising: boolean | null; triggerTime: string | null };
export type ScalperDecision = {
  mode: "SCALP" | "HEDGE" | "WAIT";
  side: "CE" | "PE" | null;
  read: MarketRead | null;
  reasons: string[];
  gates: Gate[];
  plan: ScalperPlan | null;
  daysToExpiry: number | null;
};

type Leg = { symbol: string; contract: "CALL" | "PUT"; strike: number; expiry: string; side: "BUY" | "SELL"; quantity: number; entry: number; ltp: number; orderId: string };
export type ScalperPosition = {
  id: string;
  kind: "SCALP" | "HEDGE" | "MANUAL";
  side: "CE" | "PE";
  underlying: string;
  legs: Leg[];
  openedAt: string;
  entry: number;
  stop: number | null;
  target: number | null;
  initialRisk: number | null;
  highWater: number;
  /** Lowest premium seen since entry (maximum adverse excursion). */
  lowWater?: number;
  trailing: boolean;
  spot: { entry: number; stop: number; target: number } | null;
  reason: string;
  /** VWAP-EMA staged trail: INITIAL → BREAKEVEN (+0.5R) → LOCKED (+1R) → TRAILING (beyond +1R). */
  trail?: { rule: TrailRule; risk: number; costPerUnit: number; stage: TrailStage };
  /** The planned entry versus the actual fill, and the risk at that fill (planned and stressed). */
  fill?: { planned: number; actual: number; deviation: number; riskReward: number; plannedLoss: number; stressedLoss: number };
  signal?: EntrySignal;
  controls?: PositionControls;
  /**
   * Partial booking (NIFTY Sniper: 1.5x the fill): `quantity` units are sold when the premium reaches
   * `price`; the rest keeps trailing. Options trade in whole lots, so a 1-lot trade has quantity 0.
   */
  partial?: { price: number; quantity: number; done: boolean; multiple?: number };
  /** This trade's hard max-loss exit (₹); defaults to the desk's max loss per trade. */
  maxLoss?: number;
  status: "OPEN" | "EXITED";
  exitAt?: string;
  exitReason?: string;
  exitValue?: number;
  realizedPnl?: number;
};
/** Position-management state (NIFTY Sniper V2 spec 14.4), derived from the stop's stage and the partial booking. */
export type PositionState = "OPEN_INITIAL" | "BREAKEVEN_PROTECTED" | "PARTIAL_BOOKED" | "PROFIT_LOCKED" | "TRAILING" | "CLOSED";
export type PositionView = ScalperPosition & { quantity: number; value: number; pnl: number; label: string; state: PositionState };
/**
 * The trader's risk controls on an open position, changeable at any time (modify): the trailing
 * mode, the fixed trail distance, whether the smart trail runs past the target, and where the
 * trail resumes after the trader moved the stop by hand (only on a new best premium).
 */
export type PositionControls = {
  mode: TrailMode;
  /** FIXED mode: the stop trails the best premium by this many rupees. */
  points: number | null;
  runPastTarget: boolean;
  /** After a manual SL edit the trail waits for a premium above this before it moves the stop again. */
  resumeAbove: number | null;
  /** The smart / fixed trail's own stage (the strategy rule keeps its stage in `trail`). */
  stage: TrailStage;
  /** R for the smart trail (premium per unit). */
  risk: number;
  /** How many times the smart trail pushed the target out (the trade ran past its target). */
  targetRuns: number;
  modifiedAt?: string;
  /** MONEY mode: the rupee stop, trail trigger, first trailed stop, step and target. */
  money?: MoneyTrailConfig;
};
export type ModifyRequest = { stop?: number | null; target?: number | null; trailMode?: TrailMode; trailPoints?: number | null; runPastTarget?: boolean; money?: MoneyTrailConfig };

/** Desk settings' money trail: numbers clamped to sane rupee ranges; invalid settings switch it off. */
export function parseMoneyTrail(raw: unknown): MoneyTrailConfig & { enabled: boolean } {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (key: keyof MoneyTrailConfig) => { const parsed = Number(value[key]); return Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_MONEY_TRAIL[key]; };
  const config: MoneyTrailConfig = { stopLoss: num("stopLoss"), trigger: num("trigger"), firstStop: num("firstStop"), step: num("step"), target: Math.max(0, num("target")) };
  return { ...config, enabled: value.enabled === true && moneyTrailError(config) === null };
}
export { TRAIL_MODES, type TrailMode };
export type TrailStage = "INITIAL" | "BREAKEVEN" | "LOCKED" | "TRAILING";

/** The VWAP-EMA scalper's staged trail, in units of the initial premium risk R (see scalper-trail). */
export { SNIPER_TRAIL, VWAP_EMA_TRAIL, sniperTrail };
export const trailLabel = (rule: TrailRule | undefined) => (rule === "SNIPER" ? "NIFTY Sniper" : rule === "VWAP_EMA" ? "VWAP-EMA" : "");

/**
 * Next stop for a VWAP-EMA scalp. R = entry − initial stop (premium). At +0.5R the stop goes to
 * a cost-covered breakeven (entry + round-trip charges per unit); at +1R it locks +0.5R; beyond +1R
 * it trails 0.6R under the best premium. The stop only ever moves up.
 */
export function vwapEmaTrail(position: { entry: number; stop: number; highWater: number; trail: { risk: number; costPerUnit: number; stage: TrailStage } }) {
  const { entry, highWater } = position;
  const { risk, costPerUnit } = position.trail;
  let stop = position.stop;
  let stage: TrailStage = position.trail.stage;
  if (!(risk > 0)) return { stop, stage };
  const gain = highWater - entry;
  if (gain >= risk * VWAP_EMA_TRAIL.breakevenAt) { stop = Math.max(stop, entry + Math.max(costPerUnit, 0)); if (stage === "INITIAL") stage = "BREAKEVEN"; }
  if (gain >= risk * VWAP_EMA_TRAIL.lockAt) { stop = Math.max(stop, entry + risk * VWAP_EMA_TRAIL.lockTo); if (stage === "INITIAL" || stage === "BREAKEVEN") stage = "LOCKED"; }
  if (gain > risk * VWAP_EMA_TRAIL.lockAt) {
    const trailed = highWater - risk * VWAP_EMA_TRAIL.trailGap;
    if (trailed > stop) { stop = trailed; stage = "TRAILING"; }
  }
  return { stop: round2(stop), stage };
}

export type ScanInput = {
  symbol: string;
  spot: number;
  /** Underlying 1-minute candles, oldest first. */
  bars: ScalperBar[];
  contracts: ScalperContract[];
  /** AUTOMATIC: the engine places its own entries. MANUAL (false): it only suggests; the trader takes the signal with `take`. */
  autoEntries: boolean;
  settings?: Partial<ScalperSettings>;
  /** Higher-timeframe demand/supply zones (e.g. market-intel 5m zones). */
  zones?: ExtraZone[];
  /** India VIX regime from market-intel; EXTREME blocks entries, HIGH prefers hedges. */
  vixRegime?: string | null;
  /** Kill switch / safe mode reason: blocks new entries, exits still run. */
  entryBlockedReason?: string;
};

export const DEFAULT_SCALPER_SETTINGS: ScalperSettings = { maxTrades: 5, maxLossPerTrade: 1500, maxDailyLoss: 4000, lots: 1, minRiskReward: 2, mode: "AUTO", maxHoldMinutes: 12, smartTrail: true, runPastTarget: true, sniperLots: 1, sniperSizing: "RISK_BUDGET", sniperSetups: "ABC", moneyTrail: { enabled: false, ...DEFAULT_MONEY_TRAIL } };
const STAGE_ORDER: TrailStage[] = ["INITIAL", "BREAKEVEN", "LOCKED", "TRAILING"];
const higherStage = (a: TrailStage, b: TrailStage) => (STAGE_ORDER.indexOf(a) >= STAGE_ORDER.indexOf(b) ? a : b);
/** Round-trip charges per unit when the plan gave none: ~₹40 brokerage per order pair plus ~0.2% of premium (STT, exchange, GST). */
const estimatedCostPerUnit = (entry: number, quantity: number) => round2(40 / Math.max(quantity, 1) + entry * 0.002);
/** R for a position with no planned stop: 15% of the premium. */
const FALLBACK_RISK_PCT = 0.15;
const flag = (value: unknown, fallback: boolean) => (value === undefined || value === null || value === "" ? fallback : value !== false && value !== "false" && value !== 0);
const STRATEGY_ID = "SMART_SCALPER";
const SCALP_WINDOW = [9 * 60 + 20, 14 * 60 + 55] as const;
const HEDGE_WINDOW = [9 * 60 + 45, 14 * 60 + 30] as const;
/**
 * Sessions are per underlying (apps/web/lib/underlyings.ts): index options 09:15 to the 15:15
 * square-off; MCX commodity options 09:00 to a 23:00 square-off, entries until 22:45.
 */
const openOf = (underlying: string) => sessionFor(underlying).open;
const squareOffOf = (underlying: string) => sessionFor(underlying).squareOff;
/** The level engine's scalp / hedge windows: the index windows, or the commodity entry window. */
const windowOf = (underlying: string, mode: "SCALP" | "HEDGE") => {
  if (!isCommodity(underlying)) return mode === "HEDGE" ? HEDGE_WINDOW : SCALP_WINDOW;
  const session = sessionFor(underlying);
  return [session.entryStart, session.entryEnd] as const;
};
const LOSS_COOLDOWN_MINUTES = 5;
const MAX_CONSECUTIVE_LOSSES = 3;
/** NIFTY Sniper AI: a sniper trade that has not reached 1.25x within this many minutes is closed (research default). */
const SNIPER_MAX_HOLD_MINUTES = 90;
const RICH_IV = 22;

const norm = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const istMinutes = (date: Date) => { const ist = new Date(date.getTime() + 330 * 60_000); return ist.getUTCHours() * 60 + ist.getUTCMinutes(); };
const istDay = (date: Date) => new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function emaSeries(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((value, index) => out.push(index === 0 ? value : (value - out[index - 1]) * k + out[index - 1]));
  return out;
}

function rsiOf(closes: number[], period = 14) {
  if (closes.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let index = closes.length - period; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change > 0) gain += change; else loss -= change;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * VWAP-EMA momentum exit: the latest COMPLETED 1-minute index candle closed back through the 9 EMA
 * against the trade (below it for a CE, above it for a PE), so the scalp's reason is gone.
 */
export function emaMomentumLost(bars: ScalperBar[], bull: boolean, now: Date) {
  const done = bars.filter((bar) => (bar.time + 60) * 1000 <= now.getTime());
  if (done.length < 10) return false;
  const ema9 = emaSeries(done.map((bar) => bar.close), 9).at(-1)!;
  const close = done.at(-1)!.close;
  return bull ? close < ema9 : close > ema9;
}

function trueRanges(bars: ScalperBar[]) {
  return bars.map((bar, index) => index === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close)));
}

/** Swing pivots (k bars each side) plus VWAP/EMA21 and external zones, merged within 0.3 ATR. */
function buildLevels(bars: ScalperBar[], atr: number, vwap: number, ema21: number, zones: ExtraZone[]) {
  const raw: Array<{ price: number; source: string }> = [];
  const k = 3;
  const window = bars.slice(-150, -1);
  for (let index = k; index < window.length - k; index += 1) {
    const slice = window.slice(index - k, index + k + 1);
    if (window[index].low <= Math.min(...slice.map((bar) => bar.low))) raw.push({ price: window[index].low, source: "1m swing low" });
    if (window[index].high >= Math.max(...slice.map((bar) => bar.high))) raw.push({ price: window[index].high, source: "1m swing high" });
  }
  const today = bars.filter((bar) => istDay(new Date(bar.time * 1000)) === istDay(new Date(bars.at(-1)!.time * 1000)));
  if (today.length > 1) {
    raw.push({ price: Math.max(...today.slice(0, -1).map((bar) => bar.high)), source: "day high" });
    raw.push({ price: Math.min(...today.slice(0, -1).map((bar) => bar.low)), source: "day low" });
  }
  raw.push({ price: vwap, source: "VWAP" }, { price: ema21, source: "EMA21" });
  for (const zone of zones) raw.push({ price: zone.side === "DEMAND" ? zone.high : zone.low, source: `5m ${zone.side.toLowerCase()} zone${zone.sources?.length ? ` (${zone.sources.slice(0, 2).join(", ")})` : ""}` });
  raw.sort((a, b) => a.price - b.price);
  const merged: Level[] = [];
  const tolerance = Math.max(atr * 0.3, 0.0001 * (bars.at(-1)?.close ?? 0));
  for (const item of raw) {
    const last = merged.at(-1);
    if (last && item.price - last.price <= tolerance) {
      last.price = (last.price * last.touches + item.price) / (last.touches + 1);
      last.touches += 1;
      if (!last.sources.includes(item.source)) last.sources.push(item.source);
    } else merged.push({ price: item.price, touches: 1, sources: [item.source] });
  }
  return merged.map((level) => ({ ...level, price: round2(level.price) }));
}

export function analyzeMarket(bars: ScalperBar[], zones: ExtraZone[] = []): MarketRead | null {
  if (bars.length < 30) return null;
  const closes = bars.map((bar) => bar.close);
  const ema9s = emaSeries(closes, 9);
  const ema21s = emaSeries(closes, 21);
  const ema9 = ema9s.at(-1)!;
  const ema21 = ema21s.at(-1)!;
  const slope = ema21 - ema21s.at(-6)!;
  const last = bars.at(-1)!;
  const sessionDay = istDay(new Date(last.time * 1000));
  const session = bars.filter((bar) => istDay(new Date(bar.time * 1000)) === sessionDay);
  const volume = session.reduce((sum, bar) => sum + bar.volume, 0);
  const typical = (bar: ScalperBar) => (bar.high + bar.low + bar.close) / 3;
  // Index candles carry no volume: fall back to an equal-weighted session average price.
  const vwap = volume > 0 ? session.reduce((sum, bar) => sum + typical(bar) * bar.volume, 0) / volume : session.reduce((sum, bar) => sum + typical(bar), 0) / session.length;
  const ranges = trueRanges(bars);
  const atr = ranges.slice(-14).reduce((sum, value) => sum + value, 0) / Math.min(14, ranges.length);
  const longAtr = ranges.slice(-60).reduce((sum, value) => sum + value, 0) / Math.min(60, ranges.length);
  const path = closes.slice(-21);
  const travel = path.slice(1).reduce((sum, value, index) => sum + Math.abs(value - path[index]), 0);
  const efficiency = travel > 0 ? Math.abs(path.at(-1)! - path[0]) / travel : 0;
  const trend = ema9 > ema21 && last.close > vwap && slope > 0 ? "UP" : ema9 < ema21 && last.close < vwap && slope < 0 ? "DOWN" : "FLAT";
  const atrRatio = longAtr > 0 ? atr / longAtr : 1;
  const regime = atrRatio >= 1.6 ? "VOLATILE" : trend !== "FLAT" && efficiency >= 0.3 ? "TRENDING" : "RANGING";
  const levels = buildLevels(bars, atr, vwap, ema21, zones);
  return {
    trend, regime, efficiency: round2(efficiency), ema9: round2(ema9), ema21: round2(ema21), vwap: round2(vwap), atr: round2(atr), atrRatio: round2(atrRatio), rsi: round2(rsiOf(closes)), close: last.close,
    supports: levels.filter((level) => level.price <= last.close).sort((a, b) => b.price - a.price),
    resistances: levels.filter((level) => level.price > last.close).sort((a, b) => a.price - b.price),
  };
}

/**
 * Entry at the level: CE needs the latest 1m candle to tag a support and close back above it
 * with a bullish rejection; PE is the mirror at resistance. Stop just beyond the level, target
 * at the next opposing level, and the trade is only valid with `minRiskReward` of room.
 */
export function findSpotSetup(bars: ScalperBar[], read: MarketRead, side: "CE" | "PE", minRiskReward: number): SpotSetup | null {
  const last = bars.at(-1)!;
  const previous = bars.at(-2)!;
  const buffer = Math.max(read.atr * 0.25, last.close * 0.0001);
  const near = read.atr * 0.3;
  const range = Math.max(last.high - last.low, 1e-9);
  const bullish = side === "CE";
  const levels = bullish ? read.supports : read.resistances;
  // Nearest level first; a wick through the level that closes back on the right side (stop hunt) counts.
  const level = levels.find((item) => bullish ? last.low <= item.price + near && last.close > item.price && item.price >= last.close - read.atr * 1.5 : last.high >= item.price - near && last.close < item.price && item.price <= last.close + read.atr * 1.5);
  if (!level) return null;
  const entry = last.close;
  const stop = bullish ? Math.min(level.price, last.low) - buffer : Math.max(level.price, last.high) + buffer;
  const risk = Math.abs(entry - stop);
  const opposing = (bullish ? read.resistances : read.supports).filter((item) => bullish ? item.price > entry + risk * 0.5 : item.price < entry - risk * 0.5);
  const next = opposing[0];
  const target = next ? next.price : bullish ? entry + Math.min(risk * 3, read.atr * 4) : entry - Math.min(risk * 3, read.atr * 4);
  const riskReward = risk > 0 ? Math.abs(target - entry) / risk : 0;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const rejection = bullish ? last.close > last.open && (lowerWick >= range * 0.35 || last.close > previous.high) : last.close < last.open && (upperWick >= range * 0.35 || last.close < previous.low);
  const gates: Gate[] = [
    { label: `${bullish ? "Support" : "Resistance"} ${level.price} tagged (${level.sources.join(", ")}${level.touches > 1 ? `, ${level.touches} touches` : ""})`, passed: true },
    { label: `${bullish ? "Bullish" : "Bearish"} 1m rejection candle`, passed: rejection },
    { label: `RSI ${read.rsi} not ${bullish ? "overbought (<70)" : "oversold (>30)"}`, passed: bullish ? read.rsi < 70 : read.rsi > 30 },
    { label: `Room to ${next ? `${bullish ? "resistance" : "support"} ${round2(target)}` : "open target"}: ${round2(riskReward)}R ≥ ${minRiskReward}R`, passed: riskReward >= minRiskReward },
  ];
  return { side, level, entry: round2(entry), stop: round2(stop), target: round2(target), riskReward: round2(riskReward), gates, ready: gates.every((gate) => gate.passed) };
}

export function valueOption(contract: ScalperContract, spot: number): Valuation {
  const intrinsic = Math.max(0, contract.contract === "CALL" ? spot - contract.strike : contract.strike - spot);
  const timeValue = Math.max(0, contract.premium - intrinsic);
  const distance = Math.abs(contract.strike - spot) / Math.max(spot, 1);
  const moneyness = distance < 0.001 ? "ATM" : intrinsic > 0 ? "ITM" : "OTM";
  return { symbol: contract.symbol, strike: contract.strike, premium: contract.premium, intrinsic: round2(intrinsic), timeValue: round2(timeValue), intrinsicPct: contract.premium > 0 ? Math.round((intrinsic / contract.premium) * 100) : 0, moneyness, delta: contract.delta, theta: contract.theta };
}

const absDelta = (contract: ScalperContract, spot: number) => {
  const delta = Math.abs(contract.delta);
  if (delta > 0.02) return delta;
  // Chains without Greeks: rough delta from moneyness (0.5 at the money).
  const itm = contract.contract === "CALL" ? spot - contract.strike : contract.strike - spot;
  return clamp(0.5 + itm / Math.max(spot * 0.02, 1), 0.05, 0.95);
};

function strikeStep(contracts: ScalperContract[]) {
  const strikes = [...new Set(contracts.map((item) => item.strike))].sort((a, b) => a - b);
  let step = Infinity;
  for (let index = 1; index < strikes.length; index += 1) step = Math.min(step, strikes[index] - strikes[index - 1]);
  return Number.isFinite(step) && step > 0 ? step : 50;
}

/** Single-leg scalp: best reward/risk after spread and theta, then the smallest ₹ risk. */
export function planScalp(setup: SpotSetup, contracts: ScalperContract[], spot: number, settings: ScalperSettings): { plan: ScalperPlan | null; reason: string } {
  const wanted = setup.side === "CE" ? "CALL" : "PUT";
  const step = strikeStep(contracts);
  const spotRisk = Math.abs(setup.entry - setup.stop);
  const spotReward = Math.abs(setup.target - setup.entry);
  const holdDays = settings.maxHoldMinutes / 375;
  const scored = contracts
    .filter((item) => item.contract === wanted && item.premium > 0 && item.lotSize > 0 && Math.abs(item.strike - spot) <= step * 2.01)
    .map((item) => {
      const delta = absDelta(item, spot);
      const spread = Math.max(item.ask - item.bid, 0);
      const risk = delta * spotRisk + spread;
      const reward = delta * spotReward - spread - Math.abs(item.theta) * holdDays;
      return { item, delta, risk, reward, rr: risk > 0 ? reward / risk : 0, riskPerLot: risk * item.lotSize };
    })
    .filter((row) => row.delta >= 0.35 && row.delta <= 0.8 && row.risk <= row.item.premium * 0.35);
  if (!scored.length) return { plan: null, reason: `no near-ATM ${setup.side} with delta 0.35-0.80 whose stop fits within 35% of premium` };
  const fits = scored.filter((row) => row.rr >= settings.minRiskReward && row.riskPerLot <= settings.maxLossPerTrade)
    .sort((a, b) => b.rr - a.rr || a.riskPerLot - b.riskPerLot);
  const best = fits[0];
  if (!best) {
    const top = [...scored].sort((a, b) => b.rr - a.rr)[0];
    return { plan: null, reason: top.riskPerLot > settings.maxLossPerTrade ? `${top.item.symbol} risks ₹${Math.round(top.riskPerLot)}/lot, above the ₹${settings.maxLossPerTrade} limit` : `${top.item.symbol} nets only ${round2(top.rr)}R after spread and theta` };
  }
  const tick = best.item.tickSize > 0 ? best.item.tickSize : 0.05;
  const toTick = (value: number) => round2(Math.round(value / tick) * tick);
  const lots = Math.max(1, Math.min(settings.lots, Math.floor(settings.maxLossPerTrade / best.riskPerLot)));
  const valuation = valueOption(best.item, spot);
  const entry = toTick(best.item.ask > 0 ? best.item.ask : best.item.premium);
  return {
    reason: "ok",
    plan: {
      kind: "SCALP", side: setup.side, lots, quantity: lots * best.item.lotSize,
      legs: [{ symbol: best.item.symbol, contract: wanted, strike: best.item.strike, side: "BUY", price: entry, valuation }],
      entry, stop: toTick(Math.max(entry - best.risk, tick)), target: toTick(entry + best.reward),
      riskPerLot: Math.round(best.riskPerLot), rewardPerLot: Math.round(best.reward * best.item.lotSize), riskReward: round2(best.rr),
      spot: { entry: setup.entry, stop: setup.stop, target: setup.target },
      reason: `${setup.side} scalp at ${setup.side === "CE" ? "support" : "resistance"} ${setup.level.price}: ${valuation.moneyness} ${best.item.strike}, delta ${round2(best.delta)}, ${round2(best.rr)}R`,
    },
  };
}

/**
 * Debit spread: long leg = the ITM strike with the highest intrinsic share (least time value to
 * bleed); short leg = the first OTM strike at/beyond the spot target (all time value, so selling
 * it offsets theta and IV crush). Risk is capped at the net debit; stop/target map the spot levels
 * through the spread's net delta.
 */
export function planHedge(setup: SpotSetup, contracts: ScalperContract[], spot: number, settings: ScalperSettings): { plan: ScalperPlan | null; reason: string } {
  const wanted = setup.side === "CE" ? "CALL" : "PUT";
  const step = strikeStep(contracts);
  const pool = contracts.filter((item) => item.contract === wanted && item.premium > 0 && item.lotSize > 0);
  const itm = (item: ScalperContract) => wanted === "CALL" ? spot - item.strike : item.strike - spot;
  const longs = pool.filter((item) => itm(item) >= -step * 0.5 && itm(item) <= step * 2.5)
    .map((item) => ({ item, valuation: valueOption(item, spot), delta: absDelta(item, spot) }))
    .filter((row) => row.delta >= 0.5 && row.delta <= 0.85)
    .sort((a, b) => b.valuation.intrinsicPct - a.valuation.intrinsicPct || Math.abs(a.delta - 0.65) - Math.abs(b.delta - 0.65));
  const long = longs[0];
  if (!long) return { plan: null, reason: `no ITM ${setup.side} (delta 0.50-0.85) for the long leg` };
  const beyond = (item: ScalperContract) => wanted === "CALL" ? item.strike >= setup.target && item.strike > long.item.strike : item.strike <= setup.target && item.strike < long.item.strike;
  const short = pool.filter(beyond).sort((a, b) => Math.abs(a.strike - setup.target) - Math.abs(b.strike - setup.target))[0];
  if (!short) return { plan: null, reason: `no OTM ${setup.side} strike at the ${setup.target} target for the short leg` };
  const longPrice = long.item.ask > 0 ? long.item.ask : long.item.premium;
  const shortPrice = short.bid > 0 ? short.bid : short.premium;
  const debit = longPrice - shortPrice;
  const width = Math.abs(short.strike - long.item.strike);
  if (!(debit > 0) || debit >= width) return { plan: null, reason: `spread ${long.item.strike}/${short.strike} debit ${round2(debit)} does not fit its ${width}-point width` };
  const netDelta = Math.max(long.delta - absDelta(short, spot), 0.05);
  const spotRisk = Math.abs(setup.entry - setup.stop);
  const spotReward = Math.abs(setup.target - setup.entry);
  const risk = Math.min(netDelta * spotRisk, debit * 0.6);
  const reward = Math.min(netDelta * spotReward, (width - debit) * 0.9);
  const rr = risk > 0 ? reward / risk : 0;
  const lotSize = long.item.lotSize;
  const riskPerLot = risk * lotSize;
  if (rr < settings.minRiskReward) return { plan: null, reason: `spread ${long.item.strike}/${short.strike} nets ${round2(rr)}R < ${settings.minRiskReward}R` };
  if (riskPerLot > settings.maxLossPerTrade) return { plan: null, reason: `spread risks ₹${Math.round(riskPerLot)}/lot, above the ₹${settings.maxLossPerTrade} limit` };
  const lots = Math.max(1, Math.min(settings.lots, Math.floor(settings.maxLossPerTrade / riskPerLot)));
  const shortValuation = valueOption(short, spot);
  const netTheta = round2(Math.abs(long.item.theta) - Math.abs(short.theta));
  return {
    reason: "ok",
    plan: {
      kind: "HEDGE", side: setup.side, lots, quantity: lots * lotSize,
      legs: [
        { symbol: long.item.symbol, contract: wanted, strike: long.item.strike, side: "BUY", price: round2(longPrice), valuation: long.valuation },
        { symbol: short.symbol, contract: wanted, strike: short.strike, side: "SELL", price: round2(shortPrice), valuation: shortValuation },
      ],
      entry: round2(debit), stop: round2(debit - risk), target: round2(debit + reward),
      riskPerLot: Math.round(riskPerLot), rewardPerLot: Math.round(reward * lotSize), riskReward: round2(rr),
      spot: { entry: setup.entry, stop: setup.stop, target: setup.target },
      reason: `${setup.side === "CE" ? "Bull call" : "Bear put"} spread ${long.item.strike}/${short.strike}: long ${long.valuation.moneyness} leg is ${long.valuation.intrinsicPct}% intrinsic (time value ${long.valuation.timeValue}), short leg is ${shortValuation.timeValue} of pure time value; net debit ${round2(debit)} (max loss), net theta ${netTheta}/day, ${round2(rr)}R`,
    },
  };
}

export class SmartScalper {
  private readonly positions: ScalperPosition[] = [];
  private readonly clock: () => Date;
  private readonly slippagePct: number;
  private tradeDate: string;
  private tradesToday = 0;
  private realizedToday = 0;
  private consecutiveLosses = 0;
  private lastLossAt: number | null = null;
  private consumedSetups = new Set<string>();
  private hydrated = false;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private lastSignal: { symbol: string; at: number; key: string } | null = null;
  /** The desk's latest settings, used by the server-side exit monitor (it has no browser). */
  private lastSettings: ScalperSettings = DEFAULT_SCALPER_SETTINGS;
  private lastDecision: ScalperDecision = { mode: "WAIT", side: null, read: null, reasons: ["Engine has not scanned yet"], gates: [], plan: null, daysToExpiry: null };

  constructor(options: { now?: () => Date; slippagePct?: number; hydrate?: boolean } = {}) {
    this.clock = options.now ?? (() => new Date());
    this.slippagePct = Math.max(0, options.slippagePct ?? 0);
    this.tradeDate = istDay(this.clock());
    this.hydrated = options.hydrate === false;
  }

  /** Serialises scans and manual actions so two requests never fill the same position twice. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  static settings(input?: Partial<ScalperSettings>): ScalperSettings {
    const value = { ...DEFAULT_SCALPER_SETTINGS, ...Object.fromEntries(Object.entries(input ?? {}).filter(([, item]) => item !== undefined && item !== null && String(item) !== "")) } as ScalperSettings;
    return {
      maxTrades: clamp(Math.floor(Number(value.maxTrades) || DEFAULT_SCALPER_SETTINGS.maxTrades), 1, 20),
      maxLossPerTrade: clamp(Number(value.maxLossPerTrade) || DEFAULT_SCALPER_SETTINGS.maxLossPerTrade, 100, 100_000),
      maxDailyLoss: clamp(Number(value.maxDailyLoss) || DEFAULT_SCALPER_SETTINGS.maxDailyLoss, 100, 500_000),
      lots: clamp(Math.floor(Number(value.lots) || 1), 1, 50),
      minRiskReward: clamp(Number(value.minRiskReward) || DEFAULT_SCALPER_SETTINGS.minRiskReward, 1, 10),
      mode: ["AUTO", "SCALP", "HEDGE"].includes(value.mode) ? value.mode : "AUTO",
      maxHoldMinutes: clamp(Math.floor(Number(value.maxHoldMinutes) || DEFAULT_SCALPER_SETTINGS.maxHoldMinutes), 2, 120),
      smartTrail: flag(value.smartTrail, DEFAULT_SCALPER_SETTINGS.smartTrail),
      runPastTarget: flag(value.runPastTarget, DEFAULT_SCALPER_SETTINGS.runPastTarget),
      sniperLots: clamp(Math.floor(Number(value.sniperLots) || DEFAULT_SCALPER_SETTINGS.sniperLots), 1, 10),
      sniperSizing: value.sniperSizing === "FIXED_LOTS" ? "FIXED_LOTS" : "RISK_BUDGET",
      sniperSetups: ["A", "B", "C"].filter((letter) => String(value.sniperSetups ?? "ABC").toUpperCase().includes(letter)).join("") || "ABC",
      moneyTrail: parseMoneyTrail(value.moneyTrail),
    };
  }

  private rollDay() {
    const today = istDay(this.clock());
    if (today === this.tradeDate) return;
    this.tradeDate = today;
    this.tradesToday = 0;
    this.realizedToday = 0;
    this.consecutiveLosses = 0;
    this.lastLossAt = null;
    this.consumedSetups.clear();
    for (let index = this.positions.length - 1; index >= 0; index -= 1) if (this.positions[index].status === "EXITED") this.positions.splice(index, 1);
  }

  private async hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    const persisted = await getActiveOrdersFromFirestore().catch(() => [] as OrderRecord[]);
    const groups = new Map<string, OrderRecord[]>();
    for (const order of persisted) {
      if (order.strategy !== STRATEGY_ID || !["OPEN", "FILLED"].includes(order.status)) continue;
      const key = order.referenceId ?? order.id;
      groups.set(key, [...(groups.get(key) ?? []), order]);
    }
    for (const [id, orders] of groups) {
      if (this.positions.some((position) => position.id === id)) continue;
      const legs: Leg[] = orders.map((order) => ({ symbol: order.symbol, contract: /PE$/.test(norm(order.symbol)) ? "PUT" : "CALL", strike: Number(order.strike ?? 0), expiry: order.expiry ?? "", side: order.side === "SELL" ? "SELL" : "BUY", quantity: order.quantity, entry: Number(order.price), ltp: Number(order.currentPrice ?? order.price), orderId: order.id }));
      const entry = legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? leg.entry : -leg.entry), 0);
      const single = orders.length === 1 ? orders[0] : undefined;
      const kind = /HEDGE/.test(orders[0].strategyName ?? "") ? "HEDGE" : /SCALP/.test(orders[0].strategyName ?? "") ? "SCALP" : "MANUAL";
      const stop = single?.stopLoss ?? null;
      const trail = (single?.trailRule === "VWAP_EMA" || single?.trailRule === "SNIPER") && single.initialStopLoss !== undefined
        ? { rule: single.trailRule as TrailRule, risk: round2(entry - single.initialStopLoss), costPerUnit: Number(single.trailCostPerUnit ?? 0), stage: (["INITIAL", "BREAKEVEN", "LOCKED", "TRAILING"].includes(String(single.trailStage)) ? single.trailStage : "INITIAL") as TrailStage }
        : undefined;
      const initialRisk = trail ? trail.risk : stop !== null ? entry - stop : null;
      const storedMode = TRAIL_MODES.includes(single?.trailMode as TrailMode) ? single!.trailMode as TrailMode : kind === "MANUAL" ? "OFF" : this.lastSettings.smartTrail ? "SMART" : "RULE";
      const controls: PositionControls = {
        mode: storedMode, points: Number(single?.trailPoints) > 0 ? Number(single!.trailPoints) : null,
        runPastTarget: single?.runPastTarget ?? (kind !== "MANUAL" && this.lastSettings.runPastTarget),
        resumeAbove: Number(single?.trailResumeAbove) > 0 ? Number(single!.trailResumeAbove) : null,
        stage: (STAGE_ORDER.includes(single?.smartStage as TrailStage) ? single!.smartStage : "INITIAL") as TrailStage,
        risk: Number(single?.smartRisk) > 0 ? Number(single!.smartRisk) : initialRisk && initialRisk > 0 ? round2(initialRisk) : round2(entry * FALLBACK_RISK_PCT),
        targetRuns: Number(single?.targetRuns ?? 0) || 0,
        ...(single?.moneyTrail && moneyTrailError(single.moneyTrail) === null ? { money: single.moneyTrail } : {}),
      };
      const partial = Number(single?.partialPrice) > 0 ? { price: Number(single!.partialPrice), quantity: Number(single!.partialQuantity ?? 0), done: Boolean(single!.partialDone), multiple: Number(single!.partialMultiple) || undefined } : undefined;
      this.positions.push({ ...(partial ? { partial } : {}), ...(Number(single?.maxLoss) > 0 ? { maxLoss: Number(single!.maxLoss) } : {}), controls, id, kind, side: legs[0].contract === "CALL" ? "CE" : "PE", underlying: orders[0].underlying ?? "", legs, openedAt: orders[0].createdAt, entry, stop, target: single?.target ?? null, initialRisk, highWater: Math.max(entry, Number(single?.highWaterMark ?? entry)), lowWater: Math.min(entry, Number(single?.lowWaterMark ?? entry)), trailing: Boolean(trail && trail.stage !== "INITIAL") || controls.stage !== "INITIAL", spot: null, reason: orders[0].source ?? "restored", status: "OPEN", ...(trail ? { trail } : {}), ...(single?.entrySignal ? { signal: single.entrySignal } : {}) });
    }
  }

  private dailyBlock(settings: ScalperSettings): string | undefined {
    if (this.realizedToday <= -settings.maxDailyLoss) return `daily loss limit hit (₹${Math.round(-this.realizedToday)} of ₹${settings.maxDailyLoss})`;
    if (this.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) return `${this.consecutiveLosses} losses in a row: engine entries stopped for the day`;
    if (this.lastLossAt !== null && this.clock().getTime() - this.lastLossAt < LOSS_COOLDOWN_MINUTES * 60_000) return `cooling down ${LOSS_COOLDOWN_MINUTES} min after a loss`;
    if (this.tradesToday >= settings.maxTrades) return `trade cap reached (${this.tradesToday}/${settings.maxTrades})`;
    return undefined;
  }

  private daysToExpiry(contracts: ScalperContract[]) {
    const expiry = contracts.map((item) => item.expiry).filter(Boolean).sort()[0];
    if (!expiry) return null;
    const days = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${istDay(this.clock())}T00:00:00Z`)) / 86_400_000);
    return Number.isFinite(days) ? Math.max(0, days) : null;
  }

  /** Decide SCALP / HEDGE / WAIT and, when every gate is green, the exact plan. */
  decide(input: ScanInput, settings: ScalperSettings): ScalperDecision {
    const reasons: string[] = [];
    const read = analyzeMarket(input.bars, input.zones ?? []);
    const daysToExpiry = this.daysToExpiry(input.contracts);
    if (!read) return { mode: "WAIT", side: null, read, reasons: [`Need 30+ one-minute candles (have ${input.bars.length})`], gates: [], plan: null, daysToExpiry };
    const minutes = istMinutes(this.clock());
    const atm = input.contracts.filter((item) => Math.abs(item.strike - input.spot) <= strikeStep(input.contracts) * 0.51);
    const atmIv = atm.length ? atm.reduce((sum, item) => sum + item.iv, 0) / atm.length : 0;
    const atmTime = atm.length ? atm.reduce((sum, item) => sum + valueOption(item, input.spot).timeValue, 0) / atm.length : 0;
    reasons.push(`1m tape: ${read.regime.toLowerCase()} ${read.trend === "FLAT" ? "with no clear trend" : `${read.trend.toLowerCase()}trend`} (efficiency ${read.efficiency}, ATR ${read.atr} = ${read.atrRatio}× normal)`);
    if (atm.length) reasons.push(`ATM time value ₹${round2(atmTime)}, IV ${round2(atmIv)}${daysToExpiry !== null ? `, ${daysToExpiry === 0 ? "expiry day" : `${daysToExpiry}d to expiry`}` : ""}`);

    let mode: "SCALP" | "HEDGE";
    const expiryAfternoon = daysToExpiry === 0 && minutes >= 13 * 60 + 30;
    const rich = atmIv >= RICH_IV || input.vixRegime === "HIGH";
    if (settings.mode !== "AUTO") { mode = settings.mode; reasons.push(`Mode forced to ${mode}`); }
    else if (read.regime === "VOLATILE") { mode = "HEDGE"; reasons.push("Range expansion: a spread caps the whipsaw risk → HEDGE"); }
    else if (rich) { mode = "HEDGE"; reasons.push(`Options are expensive (IV ${round2(atmIv)}${input.vixRegime === "HIGH" ? ", VIX high" : ""}): sell OTM time value against the buy → HEDGE`); }
    else if (expiryAfternoon) { mode = "HEDGE"; reasons.push("Expiry afternoon: time value collapses on naked buys → HEDGE"); }
    else { mode = "SCALP"; reasons.push(read.regime === "TRENDING" ? "Clean trend: buy pullbacks to support with the trend → SCALP" : "Range: buy CE at range support, PE at range resistance → SCALP"); }

    // With-trend side only in a trend; both sides in a range; a volatile tape with no trend has no edge.
    const sides: Array<"CE" | "PE"> = read.trend === "UP" ? ["CE"] : read.trend === "DOWN" ? ["PE"] : read.regime === "VOLATILE" && mode === "HEDGE" ? [] : ["CE", "PE"];
    if (!sides.length) return { mode: "WAIT", side: null, read, reasons: [...reasons, "Volatile with no direction: standing aside"], gates: [], plan: null, daysToExpiry };
    const setups = sides.map((side) => findSpotSetup(input.bars, read, side, settings.minRiskReward)).filter((item): item is SpotSetup => item !== null);
    const window = windowOf(input.symbol, mode);
    const timeGate: Gate = { label: `${mode === "HEDGE" ? "Hedge" : "Scalp"} entry window ${hhmm(window[0])}-${hhmm(window[1])} IST`, passed: minutes >= window[0] && minutes <= window[1] };
    if (!setups.length) {
      const nearest = sides.map((side) => side === "CE" ? (read.supports[0] ? `support ${read.supports[0].price}` : null) : (read.resistances[0] ? `resistance ${read.resistances[0].price}` : null)).filter(Boolean).join(" / ");
      return { mode: "WAIT", side: sides.length === 1 ? sides[0] : null, read, reasons: [...reasons, `Waiting for price to reach ${nearest || "a level"} and reject it`], gates: [timeGate], plan: null, daysToExpiry };
    }
    const setup = setups.find((item) => item.ready) ?? setups.sort((a, b) => b.gates.filter((gate) => gate.passed).length - a.gates.filter((gate) => gate.passed).length)[0];
    const gates = [timeGate, ...setup.gates];
    if (!gates.every((gate) => gate.passed)) return { mode: "WAIT", side: setup.side, read, reasons: [...reasons, `${setup.side} setup at ${setup.level.price} forming: ${gates.filter((gate) => !gate.passed).map((gate) => gate.label).join("; ")}`], gates, plan: null, daysToExpiry };
    const { plan, reason } = mode === "HEDGE" ? planHedge(setup, input.contracts, input.spot, settings) : planScalp(setup, input.contracts, input.spot, settings);
    gates.push({ label: plan ? `Contract fits risk: ₹${plan.riskPerLot}/lot for ${plan.riskReward}R` : `Contract: ${reason}`, passed: Boolean(plan) });
    if (!plan) return { mode: "WAIT", side: setup.side, read, reasons: [...reasons, reason], gates, plan: null, daysToExpiry };
    return { mode, side: setup.side, read, reasons: [...reasons, plan.reason], gates, plan, daysToExpiry };
  }

  scan(input: ScanInput) {
    return this.serial(async () => {
      await this.hydrate();
      this.rollDay();
      const settings = SmartScalper.settings(input.settings);
      this.lastSettings = settings;
      const now = this.clock();
      this.mark(input.contracts);
      this.manageExits(input, settings);
      let decision = this.decide(input, settings);
      const block = this.entryBlock(input.symbol, settings, input.entryBlockedReason ?? (input.vixRegime === "EXTREME" ? "India VIX is EXTREME" : undefined));
      const key = decision.plan ? `${decision.plan.kind}:${decision.side}:${decision.plan.spot.stop}:${input.bars.at(-1)?.time}` : "";
      let summary: string;
      if (block) { summary = `Entries paused: ${block}. Open positions are still managed.`; decision = { ...decision, reasons: [...decision.reasons, `Entries paused: ${block}`] }; }
      else if (!decision.plan) summary = decision.reasons.at(-1) ?? "Waiting for a setup";
      else if (this.consumedSetups.has(key)) summary = "Setup already traded.";
      else if (!input.autoEntries) summary = `Manual mode · signal ready: ${decision.plan.kind} ${decision.plan.legs.map((leg) => `${leg.side} ${leg.symbol} @ ${leg.price}`).join(" + ")} · SL ${decision.plan.stop} · T ${decision.plan.target} · ${decision.plan.riskReward}R. Press "Take trade" to enter.`;
      else {
        this.consumedSetups.add(key);
        const position = this.open(input.symbol, decision.plan, input.contracts, false, settings);
        summary = `${position.kind} entered: ${position.legs.map((leg) => `${leg.side} ${leg.symbol} @ ${leg.entry}`).join(" + ")} · SL ${position.stop} · T ${position.target}`;
      }
      this.lastSignal = decision.plan && !block && !this.consumedSetups.has(key) ? { symbol: input.symbol, at: now.getTime(), key } : null;
      this.lastDecision = decision;
      return { ...this.state(input.symbol), decision, summary, signalReady: this.lastSignal !== null };
    });
  }

  /** Why new engine entries are not allowed right now (undefined = allowed). */
  private entryBlock(symbol: string, settings: ScalperSettings, external?: string) {
    if (external) return external;
    const daily = this.dailyBlock(settings);
    if (daily) return daily;
    if (istMinutes(this.clock()) >= squareOffOf(symbol)) return `after the ${hhmm(squareOffOf(symbol))} IST square-off`;
    if (this.positions.some((position) => position.status === "OPEN" && position.kind !== "MANUAL" && position.underlying === symbol)) return "an engine position is already open (one at a time)";
    return undefined;
  }

  /**
   * Manual mode: enter the engine's latest signal on the trader's click. The signal must be from
   * the last minute; legs are re-priced at the live premium and the stop keeps its planned distance.
   */
  take(symbol: string, contracts: ScalperContract[], input: { settings?: Partial<ScalperSettings>; entryBlockedReason?: string } = {}) {
    return this.serial(async () => {
      await this.hydrate();
      this.rollDay();
      const settings = SmartScalper.settings(input.settings);
      const signal = this.lastSignal;
      const plan = this.lastDecision.plan;
      if (!signal || !plan || signal.symbol !== symbol || this.clock().getTime() - signal.at > 60_000 || this.consumedSetups.has(signal.key)) return { ...this.state(symbol), decision: this.lastDecision, signalReady: false, error: "No fresh engine signal to take. Wait for the next setup." };
      const block = this.entryBlock(symbol, settings, input.entryBlockedReason);
      if (block) return { ...this.state(symbol), decision: this.lastDecision, signalReady: false, error: `Entry blocked: ${block}` };
      const prices = new Map(contracts.map((item) => [norm(item.symbol), item]));
      const legs = plan.legs.map((leg) => { const live = prices.get(norm(leg.symbol)); return live ? { ...leg, price: leg.side === "BUY" ? (live.ask || live.premium) : (live.bid || live.premium) } : leg; });
      this.consumedSetups.add(signal.key);
      this.lastSignal = null;
      const position = this.open(symbol, { ...plan, legs }, contracts, false, settings);
      return { ...this.state(symbol), decision: this.lastDecision, signalReady: false, summary: `${position.kind} taken: ${position.legs.map((leg) => `${leg.side} ${leg.symbol} @ ${leg.entry}`).join(" + ")} · SL ${position.stop} · T ${position.target}` };
    });
  }

  /**
   * Place a scalp confirmed elsewhere (the VWAP-EMA scalper on the algo page) into this paper book.
   * The book's own limits still decide: kill switch / safe mode, daily loss, loss streak and
   * cool-down, trade cap, one engine position per index and the 15:15 square-off. The leg is
   * re-priced at the live ask and the stop keeps its planned distance. A setup id is placed once.
   */
  place(underlying: string, plan: ScalperPlan, contracts: ScalperContract[], input: { setupId: string; settings?: Partial<ScalperSettings>; entryBlockedReason?: string; ruleLimits?: { maxTrades: number; maxConsecutiveLosses: number } }) {
    return this.serial(async () => {
      await this.hydrate();
      this.rollDay();
      const settings = SmartScalper.settings(input.settings);
      if (!input.setupId) return { ...this.state(underlying), placed: false, error: "A setup id is required." };
      if (this.consumedSetups.has(input.setupId)) return { ...this.state(underlying), placed: false, error: "This setup was already placed on the scalper." };
      const now = this.clock();
      const weekday = new Date(now.getTime() + 330 * 60_000).getUTCDay();
      if (weekday === 0 || weekday === 6 || istMinutes(now) < openOf(underlying) || istMinutes(now) >= squareOffOf(underlying)) return { ...this.state(underlying), placed: false, error: `Scalper entries for ${underlying} are open ${hhmm(openOf(underlying))}-${hhmm(squareOffOf(underlying))} IST on trading days.` };
      // One VWAP-EMA trade at a time on ANY index: the next entry waits until the open trade exits
      // (target, SL or trailing SL; or a time / momentum / 15:15 / manual exit).
      const open = this.openEngineTrade();
      if (open) return { ...this.state(underlying), placed: false, blockedByOpenTrade: true, error: `A trade is already open (BUY ${open.label} on ${open.underlying}, SL ₹${open.stop ?? "--"} · T ₹${open.target ?? "--"}): no new trade until it exits at its target, SL or trailing SL.` };
      const block = this.entryBlock(underlying, settings, input.entryBlockedReason);
      if (block) return { ...this.state(underlying), placed: false, error: `Entry blocked: ${block}` };
      if (plan.trail && input.ruleLimits) {
        // A strategy's own daily locks (NIFTY Sniper: 3 entries, 2 consecutive losses), on top of the book's.
        const stats = this.ruleStatsNow(plan.trail.rule);
        if (stats.trades >= input.ruleLimits.maxTrades) return { ...this.state(underlying), placed: false, error: `Entry blocked: ${trailLabel(plan.trail.rule)} entry cap reached (${stats.trades}/${input.ruleLimits.maxTrades} today)` };
        if (stats.consecutiveLosses >= input.ruleLimits.maxConsecutiveLosses) return { ...this.state(underlying), placed: false, error: `Entry blocked: ${trailLabel(plan.trail.rule)} consecutive-loss lock (${stats.consecutiveLosses} losses in a row today)` };
      }
      if (!plan.legs.length || !(plan.quantity > 0) || !(plan.stop > 0) || !(plan.target > plan.entry) || !(plan.entry > plan.stop)) return { ...this.state(underlying), placed: false, error: "The scalp plan needs one leg, a quantity, and a stop below and a target above the entry." };
      this.lastSettings = settings;
      const prices = new Map(contracts.map((item) => [norm(item.symbol), item]));
      const legs = plan.legs.map((leg) => { const live = prices.get(norm(leg.symbol)); return live ? { ...leg, price: live.ask || live.premium } : leg; });
      let sized = plan;
      let fill: ScalperPosition["fill"];
      let partial: ScalperPosition["partial"];
      let maxLoss: number | undefined;
      if (plan.risk) {
        // Re-plan on the ACTUAL fill (live ask + slippage), with the stop and target left at their
        // structural prices, and refuse when the fill has drifted or the risk no longer fits.
        const r = plan.risk;
        const live = prices.get(norm(plan.legs[0].symbol));
        const tick = live?.tickSize || 0.05;
        const actual = this.fill(legs[0].price, "BUY", tick);
        if (actual > r.maxEntry + 1e-9) return { ...this.state(underlying), placed: false, error: `Fill ₹${actual} is above the planned entry ₹${plan.entry} plus tolerance (max ₹${r.maxEntry}): the setup has moved, not placed.` };
        const multiples = r.premiumMultiples;
        // Sniper: stop and target are multiples of the ACTUAL fill, never of the requested price.
        const stopPrice = multiples ? round2(Math.round(actual * multiples.stop / tick) * tick) : plan.stop;
        const riskUnit = round2(actual - stopPrice);
        if (!(riskUnit > 0)) return { ...this.state(underlying), placed: false, error: `At the ₹${actual} fill the stop ₹${stopPrice} is not below the entry.` };
        // R and the target from the ACTUAL fill (k = the chosen ratio), capped at the OI wall.
        const k = plan.riskReward > 0 ? plan.riskReward : 2;
        const wanted = multiples ? round2(Math.ceil(actual * multiples.target / tick - 1e-9) * tick) : round2(Math.ceil((actual + k * riskUnit) / tick - 1e-9) * tick);
        const target = r.maxTarget > 0 ? Math.min(wanted, round2(Math.floor(r.maxTarget / tick + 1e-9) * tick)) : wanted;
        const rewardUnit = round2(target - actual);
        if (!(rewardUnit > 0)) return { ...this.state(underlying), placed: false, error: `At the ₹${actual} fill there is no room to a target below the OI wall (₹${r.maxTarget}).` };
        const riskReward = round2(rewardUnit / riskUnit);
        if (riskReward < r.minRiskReward) return { ...this.state(underlying), placed: false, error: `At the ₹${actual} fill the reward:risk is ${riskReward} (needs ${r.minRiskReward}): not placed.` };
        const lot = r.lotSize || Math.max(1, Math.round(plan.quantity / Math.max(plan.lots, 1)));
        const exitSlip = stopPrice * this.slippagePct;
        const plannedLot = riskUnit * lot + r.feesAtStopPerLot + exitSlip * lot;
        const stressedLot = plannedLot + r.stopGap * lot;
        const lots = r.fixedLots && r.fixedLots >= 1 ? Math.floor(r.fixedLots) : Math.min(plan.lots, Math.floor(settings.maxLossPerTrade / stressedLot));
        if (r.fixedLots) maxLoss = Math.max(settings.maxLossPerTrade, Math.round(stressedLot * lots * 1.25));
        if (lots < 1) return { ...this.state(underlying), placed: false, error: `At the ₹${actual} fill one lot risks ₹${Math.round(stressedLot)} stressed (gap + slippage), more than the ₹${settings.maxLossPerTrade} max loss per trade.` };
        sized = { ...plan, lots, quantity: lots * lot, riskReward, target, stop: stopPrice };
        if (multiples?.partial && multiples.partial > 1) {
          const price = round2(Math.ceil(actual * multiples.partial / tick - 1e-6) * tick);
          partial = { price, quantity: Math.floor(lots / 2) * lot, done: false, multiple: multiples.partial };
        }
        fill = { planned: plan.entry, actual, deviation: round2(actual - plan.entry), riskReward, plannedLoss: round2(plannedLot * lots), stressedLoss: round2(stressedLot * lots) };
      }
      this.consumedSetups.add(input.setupId);
      const position = this.open(underlying, { ...sized, legs }, contracts, Boolean(plan.risk), settings);
      if (partial) position.partial = partial;
      // Chosen lots: the hard max-loss exit scales with this trade's own stressed risk (+25% for gaps),
      // so a multi-lot trade is closed by its stop, not by the single-lot ₹ budget.
      if (maxLoss) position.maxLoss = maxLoss;
      if (fill || partial || maxLoss) { if (fill) position.fill = fill; this.persist(position); }
      return { ...this.state(underlying), placed: true, position: this.view(position), summary: `${position.kind} placed on the scalper: BUY ${position.legs[0].symbol} × ${position.legs[0].quantity} @ ${position.entry}${fill ? ` (planned ${fill.planned}, ${fill.deviation >= 0 ? "+" : ""}${fill.deviation})` : ""} · SL ${position.stop} · T ${position.target}${fill ? ` · ${fill.riskReward}R at the fill · max loss ₹${fill.stressedLoss} stressed` : ""}` };
    });
  }

  /**
   * Exits only (no entries): mark the open legs, then SL / target / staged trail / momentum /
   * time stop / max loss / square-off. The server-side monitor calls this without a browser.
   */
  manage(input: { symbol: string; spot: number; bars: ScalperBar[]; contracts: ScalperContract[]; settings?: Partial<ScalperSettings> }) {
    return this.serial(async () => {
      await this.hydrate();
      this.rollDay();
      const settings = input.settings ? SmartScalper.settings(input.settings) : this.lastSettings;
      const before = new Set(this.positions.filter((position) => position.status === "OPEN").map((position) => position.id));
      const known = new Set(this.positions.map((position) => position.id));
      this.mark(input.contracts);
      this.manageExits({ symbol: input.symbol, spot: input.spot, bars: input.bars, contracts: input.contracts, autoEntries: false }, settings);
      // Closed this tick: positions that were open, and slices booked this tick (partial bookings).
      const exited = this.positions.filter((position) => position.status === "EXITED" && (before.has(position.id) || !known.has(position.id))).map((position) => this.view(position));
      return { ...this.state(input.symbol), exited };
    });
  }

  /** Today's entries and current losing streak for one trailing rule (a strategy's own locks). */
  private ruleStatsNow(rule: TrailRule) {
    const mine = this.positions.filter((position) => position.trail?.rule === rule && !/-p[0-9a-z]+$/.test(position.id));
    const exited = mine.filter((position) => position.status === "EXITED").sort((a, b) => Date.parse(a.exitAt ?? "") - Date.parse(b.exitAt ?? ""));
    let consecutiveLosses = 0;
    for (const position of exited) consecutiveLosses = (position.realizedPnl ?? 0) < 0 ? consecutiveLosses + 1 : 0;
    return { trades: mine.length, consecutiveLosses, realized: round2(exited.reduce((sum, position) => sum + (position.realizedPnl ?? 0), 0)) };
  }

  ruleStats(rule: TrailRule) {
    return this.serial(async () => { await this.hydrate(); this.rollDay(); return this.ruleStatsNow(rule); });
  }

  /** The open engine trade (SCALP / HEDGE, any index), or null: the one-at-a-time rule for VWAP-EMA entries. */
  openEngineTrade(): PositionView | null {
    const open = this.positions.find((position) => position.status === "OPEN" && position.kind !== "MANUAL");
    return open ? this.view(open) : null;
  }

  /** Same, after loading persisted positions (a fresh server process). */
  currentEngineTrade() {
    return this.serial(async () => { await this.hydrate(); return this.openEngineTrade(); });
  }

  /** Open positions grouped by underlying, with their leg symbols (for the exit monitor). */
  openBook() {
    return this.serial(async () => {
      await this.hydrate();
      const book = new Map<string, Set<string>>();
      for (const position of this.positions) {
        if (position.status !== "OPEN") continue;
        const legs = book.get(position.underlying) ?? new Set<string>();
        for (const leg of position.legs) legs.add(leg.symbol);
        book.set(position.underlying, legs);
      }
      return [...book.entries()].map(([underlying, symbols]) => ({ underlying, symbols: [...symbols] }));
    });
  }

  /** Paper fill: slippage against the trader, rounded to the tick against the trader (up for a buy, down for a sell). */
  private fill(price: number, side: "BUY" | "SELL", tick = 0.05) {
    const raw = side === "BUY" ? price * (1 + this.slippagePct) : price * (1 - this.slippagePct);
    const steps = raw / tick;
    const rounded = side === "BUY" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
    return Math.max(round2(rounded * tick), tick);
  }

  /**
   * anchorStop (VWAP-EMA plans): the stop stays at its structural price, so adverse entry slippage
   * widens the risk (re-checked by place()) instead of silently tightening the stop. Otherwise the
   * level engine's convention applies and the stop keeps its planned distance from the fill.
   */
  private open(underlying: string, plan: ScalperPlan, contracts: ScalperContract[], anchorStop = false, settings: ScalperSettings = this.lastSettings) {
    const id = `scalper-${this.tradeDate}-${++this.sequence}-${Date.now().toString(36)}`;
    const timestamp = this.clock().toISOString();
    const legs: Leg[] = plan.legs.map((leg, index) => {
      const contract = contracts.find((item) => norm(item.symbol) === norm(leg.symbol));
      const entry = this.fill(leg.price, leg.side, contract?.tickSize || 0.05);
      return { symbol: leg.symbol, contract: leg.contract, strike: leg.strike, expiry: contract?.expiry ?? "", side: leg.side, quantity: plan.quantity, entry, ltp: leg.price, orderId: `${id}-L${index + 1}` };
    });
    const entry = round2(legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? leg.entry : -leg.entry), 0));
    // Level engine: the stop keeps its planned distance from the fill. VWAP-EMA: the stop stays at
    // its structural price and the risk at the fill was re-checked before opening.
    const shift = anchorStop ? 0 : entry - plan.entry;
    const position: ScalperPosition = {
      id, kind: plan.kind, side: plan.side, underlying, legs, openedAt: timestamp, entry,
      stop: round2(plan.stop + shift), target: round2(plan.target), initialRisk: round2((anchorStop ? entry : plan.entry) - plan.stop), highWater: entry, lowWater: entry, trailing: false,
      spot: plan.spot, reason: plan.reason, status: "OPEN", ...(plan.signal ? { signal: plan.signal } : {}),
      // R for the staged trail is measured from the ACTUAL entry to the stop.
      ...(plan.trail ? { trail: { rule: plan.trail.rule, risk: round2((anchorStop ? entry : plan.entry) - plan.stop), costPerUnit: round2(plan.trail.costPerUnit), stage: "INITIAL" as TrailStage } } : {}),
    };
    // Every engine trade starts on the smart auto trail (unless switched off in the settings); the
    // trader can change the SL, target and trailing on the position at any time (modify).
    // NIFTY Sniper V2 (spec 14.4 / 14.5): one deterministic trail (its own staged rule) and the 2x
    // target closes the remainder; no smart trail or runner unless the trader switches it on the trade.
    const deterministic = plan.trail?.rule === "SNIPER";
    const smart = settings.smartTrail && !deterministic;
    position.controls = { mode: smart ? "SMART" : "RULE", points: null, runPastTarget: smart && settings.runPastTarget, resumeAbove: null, stage: "INITIAL", risk: position.initialRisk && position.initialRisk > 0 ? position.initialRisk : round2(entry * FALLBACK_RISK_PCT), targetRuns: 0 };
    // Money trail on (desk settings): the rupee P&L stop / trail / target replaces the strategy's.
    if (settings.moneyTrail.enabled) {
      const { enabled: _enabled, ...money } = settings.moneyTrail;
      void _enabled;
      const prices = moneyTrailPrices({ entry, quantity: plan.quantity, bestPnl: 0, config: money });
      Object.assign(position.controls, { mode: "MONEY", money, runPastTarget: false });
      position.stop = prices.stop;
      if (prices.target !== null) position.target = prices.target;
    }
    this.positions.push(position);
    this.tradesToday += 1;
    this.persist(position);
    return position;
  }

  private mark(contracts: ScalperContract[]) {
    const prices = new Map(contracts.map((item) => [norm(item.symbol), item.premium]));
    for (const position of this.positions) {
      if (position.status !== "OPEN") continue;
      for (const leg of position.legs) { const price = prices.get(norm(leg.symbol)); if (price && price > 0) leg.ltp = price; }
    }
  }

  private netValue(position: ScalperPosition) { return round2(position.legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? leg.ltp : -leg.ltp), 0)); }
  private quantity(position: ScalperPosition) { return position.legs[0]?.quantity ?? 0; }

  private manageExits(input: ScanInput, settings: ScalperSettings) {
    const now = this.clock();
    const minutes = istMinutes(now);
    for (const position of this.positions) {
      if (position.status !== "OPEN") continue;
      const value = this.netValue(position);
      const pnl = (value - position.entry) * this.quantity(position);
      let reason: string | null = null;
      // Each position squares off at its own market's time (15:15 index options, 23:00 MCX).
      if (minutes >= squareOffOf(position.underlying)) reason = `SQUARE_OFF_${hhmm(squareOffOf(position.underlying)).replace(":", "_")}`;
      else if (pnl <= -(position.maxLoss ?? settings.maxLossPerTrade)) reason = "MAX_LOSS_PER_TRADE";
      if (!reason && position.underlying === input.symbol) {
        const risk = position.initialRisk ?? 0;
        position.highWater = Math.max(position.highWater, value);
        position.lowWater = Math.min(position.lowWater ?? position.entry, value);
        this.trailStop(position, value, squareOffOf(position.underlying) - minutes);
        // Partial booking: sell the planned lots at the partial level once; the rest keeps trailing.
        const part = position.partial;
        if (part && !part.done && position.controls?.mode !== "MONEY" && part.quantity > 0 && part.quantity < this.quantity(position) && value >= part.price) {
          part.done = true;
          this.close(position, `PARTIAL_${String(part.multiple ?? "").replace(".", "_")}X`, part.quantity);
        }
        const spotPrice = input.spot;
        const bull = position.side === "CE";
        const manual = position.kind === "MANUAL";
        // The sniper manages the PREMIUM to its 2x target; the index level is only an invalidation.
        const sniper = position.trail?.rule === "SNIPER";
        // Smart trail with run-past-target: the target never closes the trade, it moves the stop up and the target out.
        const runner = position.controls?.mode === "SMART" && position.controls.runPastTarget;
        // Index levels only with a valid spot: a missing quote (0) must never read as a broken level.
        const spotKnown = Number.isFinite(spotPrice) && spotPrice > 0;
        if (!manual && spotKnown && position.spot && (bull ? spotPrice <= position.spot.stop : spotPrice >= position.spot.stop)) reason = "SPOT_LEVEL_BROKEN";
        else if (!manual && !sniper && !runner && spotKnown && position.spot && (bull ? spotPrice >= position.spot.target : spotPrice <= position.spot.target)) reason = "SPOT_TARGET";
        else if (!runner && position.target !== null && value >= position.target) reason = position.controls?.mode === "MONEY" ? "MONEY_TARGET" : sniper ? "TARGET_2X" : "TARGET";
        else if (position.stop !== null && value <= position.stop) reason = this.stopReason(position);
        else if (!manual && !sniper && position.trail && position.trail.stage !== "INITIAL" && emaMomentumLost(input.bars, bull, now)) reason = "EMA9_LOST";
        else if (!manual && sniper && now.getTime() - Date.parse(position.openedAt) >= SNIPER_MAX_HOLD_MINUTES * 60_000 && value < position.entry * SNIPER_TRAIL.breakevenAt) reason = "SNIPER_TIME_STOP";
        else if (!manual && !sniper && position.kind === "SCALP" && risk > 0 && now.getTime() - Date.parse(position.openedAt) >= settings.maxHoldMinutes * 60_000 && value - position.entry < risk * 0.5) reason = "SCALP_TIME_STOP";
      }
      if (reason) this.close(position, reason);
    }
  }

  /** The stage the stop is in: the strategy rule's or the smart / fixed trail's, whichever is further. */
  private stageOf(position: ScalperPosition): TrailStage {
    const rule = position.trail?.stage ?? (position.trailing && !position.controls ? "TRAILING" : "INITIAL");
    return position.controls && position.controls.mode !== "RULE" ? higherStage(rule, position.controls.stage) : rule;
  }

  private stopReason(position: ScalperPosition) {
    // Money rule: the initial ₹ stop until the trail trigger is reached, the ₹ trail after it.
    if (position.controls?.mode === "MONEY") return position.controls.stage === "TRAILING" ? "MONEY_TRAIL_STOP" : "MONEY_STOP_LOSS";
    if (position.controls?.targetRuns) return "RUNNER_STOP";
    const stage = this.stageOf(position);
    if (stage === "INITIAL") return position.trailing && position.stop !== null && position.stop > position.entry ? "TRAILING_STOP" : "STOP_LOSS";
    return stage === "BREAKEVEN" ? "BREAKEVEN_STOP" : stage === "LOCKED" ? "LOCKED_PROFIT_STOP" : "TRAILING_STOP";
  }

  /**
   * Move the stop (only ever up) by the position's trailing mode:
   *  RULE  — the strategy's own trail (VWAP-EMA, NIFTY Sniper, or the level engine's 1R / 1.5R trail);
   *  SMART — the strategy rule (if any) AND the smart auto trail, the higher stop wins; may run past the target;
   *  FIXED — the best premium minus the trader's distance;
   *  OFF   — the stop stays where the trader put it.
   * After a manual SL edit nothing moves the stop until the premium makes a new best (resumeAbove).
   */
  private trailStop(position: ScalperPosition, value: number, minutesToClose: number) {
    const controls = position.controls;
    const mode: TrailMode = controls?.mode ?? (position.kind === "MANUAL" ? "OFF" : "RULE");
    if (mode === "OFF") return;
    if (controls?.resumeAbove !== null && controls?.resumeAbove !== undefined) {
      if (!(position.highWater > controls.resumeAbove)) return;
      controls.resumeAbove = null;
    }
    const before = { stop: position.stop, target: position.target, stage: position.trail?.stage, smart: controls?.stage };
    if ((mode === "RULE" || mode === "SMART") && position.stop !== null) {
      if (position.trail) {
        // Staged, cost-covered trail: VWAP-EMA in units of R, NIFTY Sniper in multiples of the fill.
        const next = position.trail.rule === "SNIPER"
          ? sniperTrail({ entry: position.entry, stop: position.stop, highWater: position.highWater, trail: position.trail })
          : vwapEmaTrail({ entry: position.entry, stop: position.stop, highWater: position.highWater, trail: position.trail });
        if (next.stop > position.stop) position.stop = next.stop;
        position.trail.stage = next.stage;
      } else if (position.kind !== "MANUAL" && (position.initialRisk ?? 0) > 0) {
        // Level engine: +1R → stop to breakeven; beyond 1.5R trail 0.75R behind the best value.
        const risk = position.initialRisk!;
        const gain = position.highWater - position.entry;
        let stop = position.stop;
        if (gain >= risk) stop = Math.max(stop, position.entry + Math.min(risk * 0.1, gain * 0.1));
        if (gain >= risk * 1.5) stop = Math.max(stop, position.highWater - risk * 0.75);
        if (stop > position.stop) position.stop = round2(stop);
      }
    }
    if (mode === "SMART" && controls) {
      const next = smartTrail({
        entry: position.entry, stop: position.stop, target: position.target, highWater: position.highWater, value,
        risk: controls.risk, costPerUnit: position.trail?.costPerUnit ?? estimatedCostPerUnit(position.entry, this.quantity(position)),
        tick: 0.05, minutesToClose, runPastTarget: controls.runPastTarget, stage: controls.stage,
      });
      position.stop = next.stop;
      position.target = next.target;
      controls.stage = next.stage;
      if (next.extended) controls.targetRuns += 1;
    }
    if (mode === "MONEY" && controls?.money) {
      // Rupee P&L stop and trail on the whole position: only ever raises the stop.
      const qty = this.quantity(position);
      const prices = moneyTrailPrices({ entry: position.entry, quantity: qty, bestPnl: (position.highWater - position.entry) * qty, config: controls.money });
      if (position.stop === null || prices.stop > position.stop) position.stop = prices.stop;
      if (prices.target !== null) position.target = prices.target;
      if (prices.trailing) controls.stage = "TRAILING";
    }
    if (mode === "FIXED" && controls?.points && controls.points > 0) {
      const trailed = round2(Math.floor((position.highWater - controls.points) / 0.05 + 1e-6) * 0.05);
      if (trailed > 0 && (position.stop === null || trailed > position.stop)) {
        position.stop = trailed;
        controls.stage = trailed > position.entry ? "TRAILING" : controls.stage;
      }
    }
    const changed = before.stop !== position.stop || before.target !== position.target || before.stage !== position.trail?.stage || before.smart !== controls?.stage;
    if (changed) {
      position.trailing = this.stageOf(position) !== "INITIAL" || (position.stop !== null && before.stop !== null && position.stop > before.stop) || position.trailing;
      this.persist(position);
    }
  }

  /**
   * Modify an open position's stop loss, target and trailing at any time (engine or manual trade).
   * The SL must stay below and the target above the live premium (use Exit to close now). A stop
   * moved by hand stays where it is put until the premium makes a new best; then the trail resumes.
   */
  modify(underlying: string, id: string, changes: ModifyRequest, contracts: ScalperContract[] = []) {
    return this.serial(async () => {
      await this.hydrate();
      this.mark(contracts);
      const position = this.positions.find((item) => item.id === id && item.status === "OPEN");
      if (!position) return { ...this.state(underlying), modified: false, error: "That position is not open any more." };
      const value = this.netValue(position);
      const tick = 0.05;
      const toTick = (price: number) => round2(Math.round(price / tick) * tick);
      const controls: PositionControls = position.controls ?? { mode: position.kind === "MANUAL" ? "OFF" : "RULE", points: null, runPastTarget: false, resumeAbove: null, stage: "INITIAL", risk: position.initialRisk && position.initialRisk > 0 ? position.initialRisk : round2(position.entry * FALLBACK_RISK_PCT), targetRuns: 0 };
      const fail = (error: string) => ({ ...this.state(underlying), modified: false, error });
      const notes: string[] = [];
      let stop = position.stop;
      let target = position.target;
      if (changes.stop !== undefined) {
        if (changes.stop === null) stop = null;
        else {
          const next = toTick(Number(changes.stop));
          if (!(next > 0)) return fail("The stop loss must be a positive premium.");
          if (next >= value) return fail(`The stop loss ₹${next} must be below the live premium ₹${value}. Use Exit to close the trade now.`);
          stop = next;
        }
      }
      if (changes.target !== undefined) {
        if (changes.target === null) target = null;
        else {
          const next = toTick(Number(changes.target));
          if (!(next > value)) return fail(`The target ₹${next} must be above the live premium ₹${value}. Use Exit to book the profit now.`);
          target = next;
        }
      }
      const mode = changes.trailMode ?? controls.mode;
      if (!TRAIL_MODES.includes(mode)) return fail(`Unknown trailing mode ${String(mode)}.`);
      if (mode === "RULE" && position.kind === "MANUAL") return fail("A manual trade has no strategy rule: pick Smart, Fixed or Off.");
      let points = controls.points;
      if (changes.trailPoints !== undefined) points = changes.trailPoints === null ? null : round2(Number(changes.trailPoints));
      if (mode === "FIXED" && !(points !== null && points > 0 && points < value)) return fail(`A fixed trail needs a distance in rupees between 0 and the premium ₹${value}.`);
      if (mode === "MONEY") {
        // The rupee rule sets the stop and target from the best P&L so far.
        const money = changes.money ?? controls.money ?? DEFAULT_MONEY_TRAIL;
        const problem = moneyTrailError(money);
        if (problem) return fail(problem);
        const qty = this.quantity(position);
        const prices = moneyTrailPrices({ entry: position.entry, quantity: qty, bestPnl: (Math.max(position.highWater, value) - position.entry) * qty, config: money });
        if (!(prices.stop < value)) return fail(`At the best P&L so far the ₹ stop (₹${prices.stopPnl}) is at ₹${prices.stop}, not below the live premium ₹${value}: exit instead, or widen it.`);
        controls.money = money;
        stop = prices.stop;
        if (prices.target !== null) target = prices.target;
        controls.stage = prices.trailing ? "TRAILING" : "INITIAL";
      }
      const stopMoved = stop !== position.stop;
      position.stop = stop;
      position.target = target;
      controls.points = points;
      if (changes.runPastTarget !== undefined) controls.runPastTarget = Boolean(changes.runPastTarget);
      if (mode !== controls.mode) {
        controls.mode = mode;
        // A trail switched on now measures R from where the stop is (or 15% of the premium).
        if (mode === "SMART" && !(position.initialRisk && position.initialRisk > 0)) controls.risk = round2(stop !== null && stop < position.entry ? position.entry - stop : position.entry * FALLBACK_RISK_PCT);
        if (!stopMoved) controls.resumeAbove = null;
      }
      // A manual SL edit is respected: the trail moves it again only on a new best premium.
      if (stopMoved) controls.resumeAbove = mode === "OFF" || mode === "MONEY" ? null : position.highWater;
      if (stopMoved && stop !== null && !(position.initialRisk && position.initialRisk > 0) && stop < position.entry && controls.risk <= 0) controls.risk = round2(position.entry - stop);
      controls.modifiedAt = this.clock().toISOString();
      position.controls = controls;
      const qty = this.quantity(position);
      const settings = this.lastSettings;
      if (stop !== null && (position.entry - stop) * qty > settings.maxLossPerTrade) notes.push(`the ₹${settings.maxLossPerTrade} max loss per trade still closes it first`);
      if (stop === null) notes.push("no stop loss: only the max loss per trade and the square-off protect it");
      this.persist(position);
      const moneyText = mode === "MONEY" && controls.money ? `₹ stop −${controls.money.stopLoss}, at +${controls.money.trigger} to ${controls.money.firstStop >= 0 ? "+" : "−"}${Math.abs(controls.money.firstStop)}, +${controls.money.step} per ₹${controls.money.step}${controls.money.target ? `, target +${controls.money.target}` : ""}` : "";
      const modeText = mode === "MONEY" ? moneyText : mode === "SMART" ? `smart auto trail${controls.runPastTarget ? ", runs past target" : ""}` : mode === "FIXED" ? `trails ₹${points} under the best premium` : mode === "RULE" ? "strategy trail" : "trailing off";
      return { ...this.state(underlying), modified: true, position: this.view(position), summary: `Modified ${this.view(position).label}: SL ${stop === null ? "none" : `₹${stop}`} · T ${target === null ? "none" : `₹${target}`} · ${modeText}${notes.length ? ` (${notes.join("; ")})` : ""}` };
    });
  }

  private close(position: ScalperPosition, reason: string, quantity?: number) {
    const total = this.quantity(position);
    const qty = Math.min(quantity ?? total, total);
    const exitLegs = position.legs.map((leg) => ({ leg, exit: this.fill(leg.ltp, leg.side === "BUY" ? "SELL" : "BUY") }));
    const exitValue = round2(exitLegs.reduce((sum, { leg, exit }) => sum + (leg.side === "BUY" ? exit : -exit), 0));
    const pnl = round2((exitValue - position.entry) * qty);
    const timestamp = this.clock().toISOString();
    if (qty < total) {
      // Partial close: book the slice as its own exited record and keep the rest open.
      const slice: ScalperPosition = { ...position, id: `${position.id}-p${Date.now().toString(36)}`, legs: position.legs.map((leg) => ({ ...leg, quantity: qty, orderId: `${leg.orderId}-p${Date.now().toString(36)}` })), status: "EXITED", exitAt: timestamp, exitReason: reason, exitValue, realizedPnl: pnl };
      for (const leg of position.legs) leg.quantity = total - qty;
      this.positions.push(slice);
      this.persist(slice, exitLegs.map(({ exit }) => exit));
      this.persist(position);
    } else {
      Object.assign(position, { status: "EXITED", exitAt: timestamp, exitReason: reason, exitValue, realizedPnl: pnl });
      this.persist(position, exitLegs.map(({ exit }) => exit));
    }
    this.realizedToday = round2(this.realizedToday + pnl);
    if (position.kind !== "MANUAL") {
      if (pnl < 0) { this.consecutiveLosses += 1; this.lastLossAt = this.clock().getTime(); } else this.consecutiveLosses = 0;
    }
    return pnl;
  }

  private persist(position: ScalperPosition, exits?: number[]) {
    position.legs.forEach((leg, index) => {
      const legPnl = (leg.side === "BUY" ? 1 : -1) * ((exits?.[index] ?? leg.ltp) - leg.entry) * leg.quantity;
      const record: OrderRecord = {
        id: leg.orderId, referenceId: position.id, strategy: STRATEGY_ID, strategyName: `Smart Scalper · ${position.kind}${position.trail ? ` · ${trailLabel(position.trail.rule)}` : ""}`, underlying: position.underlying,
        symbol: leg.symbol, growwSymbol: leg.symbol, expiry: leg.expiry, strike: leg.strike, side: leg.side, quantity: leg.quantity, lotSize: leg.quantity,
        price: leg.entry, currentPrice: leg.ltp, pnl: round2(legPnl),
        ...(position.legs.length === 1 && position.stop !== null ? { stopLoss: position.stop, target: position.target ?? undefined, trailingStop: position.trailing ? position.stop : undefined } : {}),
        ...(position.trail ? { trailRule: position.trail.rule, trailStage: position.trail.stage, trailCostPerUnit: position.trail.costPerUnit, initialStopLoss: round2(position.entry - position.trail.risk), highWaterMark: position.highWater } : {}),
        ...(position.lowWater !== undefined ? { lowWaterMark: position.lowWater } : {}),
        ...(position.maxLoss ? { maxLoss: position.maxLoss } : {}),
        ...(position.partial ? { partialPrice: position.partial.price, partialQuantity: position.partial.quantity, partialDone: position.partial.done, partialMultiple: position.partial.multiple } : {}),
        ...(position.controls ? { trailMode: position.controls.mode, trailPoints: position.controls.points ?? undefined, runPastTarget: position.controls.runPastTarget, trailResumeAbove: position.controls.resumeAbove ?? undefined, smartStage: position.controls.stage, smartRisk: position.controls.risk, targetRuns: position.controls.targetRuns, highWaterMark: position.highWater, ...(position.controls.money ? { moneyTrail: position.controls.money } : {}) } : {}),
        ...(position.signal ? { entrySignal: position.signal } : {}),
        status: position.status === "OPEN" ? "OPEN" : "EXITED", mode: "PAPER", source: position.reason, createdAt: position.openedAt, updatedAt: this.clock().toISOString(),
        ...(position.status === "EXITED" ? { exitPrice: exits?.[index], exitAt: position.exitAt, exitReason: position.exitReason, realizedPnl: round2(legPnl) } : {}),
      };
      void saveOrderToFirestore(record).catch(() => undefined);
    });
  }

  /** Manual buy from the scalper cards: averages into an open long on the same contract. */
  buy(underlying: string, contract: ScalperContract, lots: number) {
    return this.serial(async () => {
      await this.hydrate();
      this.rollDay();
      const now = this.clock();
      const weekday = new Date(now.getTime() + 330 * 60_000).getUTCDay();
      if (weekday === 0 || weekday === 6 || istMinutes(now) < openOf(underlying) || istMinutes(now) >= squareOffOf(underlying)) return { ...this.state(underlying), error: `Scalper entries for ${underlying} are open ${hhmm(openOf(underlying))}-${hhmm(squareOffOf(underlying))} IST on trading days.` };
      const qty = Math.max(1, Math.floor(lots)) * Math.max(1, contract.lotSize);
      const fill = this.fill(contract.ask > 0 ? contract.ask : contract.premium, "BUY", contract.tickSize || 0.05);
      const existing = this.positions.find((position) => position.status === "OPEN" && position.legs.length === 1 && norm(position.legs[0].symbol) === norm(contract.symbol) && position.legs[0].side === "BUY");
      if (existing) {
        const leg = existing.legs[0];
        leg.entry = round2((leg.entry * leg.quantity + fill * qty) / (leg.quantity + qty));
        leg.quantity += qty;
        leg.ltp = contract.premium;
        existing.entry = leg.entry;
        existing.highWater = Math.max(existing.highWater, existing.entry);
        this.persist(existing);
        return { ...this.state(underlying), summary: `Added ${qty} ${contract.symbol} @ ${fill}; avg ${leg.entry}` };
      }
      const id = `scalper-${this.tradeDate}-${++this.sequence}-${Date.now().toString(36)}`;
      const position: ScalperPosition = {
        id, kind: "MANUAL", side: contract.contract === "CALL" ? "CE" : "PE", underlying, openedAt: this.clock().toISOString(), entry: fill, stop: null, target: null, initialRisk: null, highWater: fill, trailing: false, spot: null, reason: "Manual scalper order", status: "OPEN",
        controls: { mode: "OFF", points: null, runPastTarget: false, resumeAbove: null, stage: "INITIAL", risk: round2(fill * FALLBACK_RISK_PCT), targetRuns: 0 },
        legs: [{ symbol: contract.symbol, contract: contract.contract, strike: contract.strike, expiry: contract.expiry, side: "BUY", quantity: qty, entry: fill, ltp: contract.premium, orderId: `${id}-L1` }],
      };
      this.positions.push(position);
      this.persist(position);
      return { ...this.state(underlying), summary: `Bought ${qty} ${contract.symbol} @ ${fill}` };
    });
  }

  /** Manual sell only reduces an open long; naked writing is not allowed. */
  sell(underlying: string, contract: ScalperContract, lots: number) {
    return this.serial(async () => {
      await this.hydrate();
      const existing = this.positions.find((position) => position.status === "OPEN" && position.legs.length === 1 && norm(position.legs[0].symbol) === norm(contract.symbol) && position.legs[0].side === "BUY");
      if (!existing) return { ...this.state(underlying), error: `No open ${contract.symbol} long to sell. Naked option writing is disabled.` };
      existing.legs[0].ltp = contract.premium;
      const sold = Math.min(Math.max(1, Math.floor(lots)) * Math.max(1, contract.lotSize), existing.legs[0].quantity);
      const pnl = this.close(existing, "MANUAL_SELL", sold);
      return { ...this.state(underlying), summary: `Sold ${sold} ${contract.symbol} · P&L ₹${pnl}` };
    });
  }

  exit(underlying: string, ids: string[] | "ALL", contracts: ScalperContract[] = []) {
    return this.serial(async () => {
      await this.hydrate();
      this.mark(contracts);
      let total = 0;
      let count = 0;
      for (const position of this.positions) {
        if (position.status !== "OPEN" || (ids !== "ALL" && !ids.includes(position.id))) continue;
        total += this.close(position, ids === "ALL" ? "MANUAL_EXIT_ALL" : "MANUAL_EXIT");
        count += 1;
      }
      return { ...this.state(underlying), summary: count ? `Exited ${count} position(s) · P&L ₹${round2(total)}` : "No open positions to exit" };
    });
  }

  /** The book for one index, or every index when `underlying` is omitted. */
  snapshot(underlying?: string) {
    return this.serial(async () => { await this.hydrate(); this.rollDay(); return { ...this.state(underlying), decision: this.lastDecision, summary: "" }; });
  }

  private view(position: ScalperPosition): PositionView {
    const quantity = this.quantity(position);
    const value = position.status === "OPEN" ? this.netValue(position) : position.exitValue ?? this.netValue(position);
    const label = position.legs.length === 1 ? position.legs[0].symbol : `${position.side === "CE" ? "Bull call" : "Bear put"} ${position.legs.map((leg) => leg.strike).join("/")}`;
    const stage = this.stageOf(position);
    const state: PositionState = position.status === "EXITED" ? "CLOSED" : stage === "TRAILING" ? "TRAILING" : stage === "LOCKED" ? "PROFIT_LOCKED" : position.partial?.done ? "PARTIAL_BOOKED" : stage === "BREAKEVEN" ? "BREAKEVEN_PROTECTED" : "OPEN_INITIAL";
    return { ...position, legs: position.legs.map((leg) => ({ ...leg })), quantity, value, pnl: position.status === "OPEN" ? round2((value - position.entry) * quantity) : position.realizedPnl ?? 0, label, state };
  }

  state(underlying?: string) {
    // Every OPEN position is listed whatever index the desk shows (an auto-placed NIFTY sniper trade must
    // appear in the positions panel while the desk is on BANKNIFTY); closed trades stay per index.
    const views = this.positions.filter((position) => position.status === "OPEN" || !underlying || position.underlying === underlying || position.underlying === "").map((position) => this.view(position));
    const open = views.filter((position) => position.status === "OPEN");
    const closed = views.filter((position) => position.status === "EXITED");
    return {
      mode: "PAPER" as const,
      positions: open,
      closed: closed.slice(-50).reverse(),
      unrealizedPnl: round2(open.reduce((sum, position) => sum + position.pnl, 0)),
      realizedPnl: round2(this.realizedToday),
      tradesToday: this.tradesToday,
      consecutiveLosses: this.consecutiveLosses,
    };
  }
}
