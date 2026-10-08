import { getActiveOrdersFromFirestore, saveOrderToFirestore, type OrderRecord } from "../../../apps/web/lib/firestore-orders";

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
};
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
  trailing: boolean;
  spot: { entry: number; stop: number; target: number } | null;
  reason: string;
  status: "OPEN" | "EXITED";
  exitAt?: string;
  exitReason?: string;
  exitValue?: number;
  realizedPnl?: number;
};
export type PositionView = ScalperPosition & { quantity: number; value: number; pnl: number; label: string };

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

export const DEFAULT_SCALPER_SETTINGS: ScalperSettings = { maxTrades: 5, maxLossPerTrade: 1500, maxDailyLoss: 4000, lots: 1, minRiskReward: 2, mode: "AUTO", maxHoldMinutes: 12 };
const STRATEGY_ID = "SMART_SCALPER";
const SCALP_WINDOW = [9 * 60 + 20, 14 * 60 + 55] as const;
const HEDGE_WINDOW = [9 * 60 + 45, 14 * 60 + 30] as const;
const MARKET_OPEN = 9 * 60 + 15;
const SQUARE_OFF = 15 * 60 + 15;
const LOSS_COOLDOWN_MINUTES = 5;
const MAX_CONSECUTIVE_LOSSES = 3;
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
      this.positions.push({ id, kind, side: legs[0].contract === "CALL" ? "CE" : "PE", underlying: orders[0].underlying ?? "", legs, openedAt: orders[0].createdAt, entry, stop, target: single?.target ?? null, initialRisk: stop !== null ? entry - stop : null, highWater: entry, trailing: false, spot: null, reason: orders[0].source ?? "restored", status: "OPEN" });
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
    const window = mode === "HEDGE" ? HEDGE_WINDOW : SCALP_WINDOW;
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
        const position = this.open(input.symbol, decision.plan, input.contracts);
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
    if (istMinutes(this.clock()) >= SQUARE_OFF) return "after the 15:15 IST square-off";
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
      const position = this.open(symbol, { ...plan, legs }, contracts);
      return { ...this.state(symbol), decision: this.lastDecision, signalReady: false, summary: `${position.kind} taken: ${position.legs.map((leg) => `${leg.side} ${leg.symbol} @ ${leg.entry}`).join(" + ")} · SL ${position.stop} · T ${position.target}` };
    });
  }

  private fill(price: number, side: "BUY" | "SELL", tick = 0.05) {
    const raw = side === "BUY" ? price * (1 + this.slippagePct) : price * (1 - this.slippagePct);
    return Math.max(round2(Math.round(raw / tick) * tick), tick);
  }

  private open(underlying: string, plan: ScalperPlan, contracts: ScalperContract[]) {
    const id = `scalper-${this.tradeDate}-${++this.sequence}-${Date.now().toString(36)}`;
    const timestamp = this.clock().toISOString();
    const legs: Leg[] = plan.legs.map((leg, index) => {
      const contract = contracts.find((item) => norm(item.symbol) === norm(leg.symbol));
      const entry = this.fill(leg.price, leg.side, contract?.tickSize || 0.05);
      return { symbol: leg.symbol, contract: leg.contract, strike: leg.strike, expiry: contract?.expiry ?? "", side: leg.side, quantity: plan.quantity, entry, ltp: leg.price, orderId: `${id}-L${index + 1}` };
    });
    const entry = round2(legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? leg.entry : -leg.entry), 0));
    // Slippage costs reward, not safety: keep the planned distance to the stop.
    const shift = entry - plan.entry;
    const position: ScalperPosition = {
      id, kind: plan.kind, side: plan.side, underlying, legs, openedAt: timestamp, entry,
      stop: round2(plan.stop + shift), target: round2(plan.target), initialRisk: round2(plan.entry - plan.stop), highWater: entry, trailing: false,
      spot: plan.spot, reason: plan.reason, status: "OPEN",
    };
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
      if (minutes >= SQUARE_OFF) reason = "SQUARE_OFF_15_15";
      else if (pnl <= -settings.maxLossPerTrade) reason = "MAX_LOSS_PER_TRADE";
      if (!reason && position.kind !== "MANUAL" && position.underlying === input.symbol) {
        const risk = position.initialRisk ?? 0;
        position.highWater = Math.max(position.highWater, value);
        // +1R → stop to breakeven; beyond 1.5R trail 0.75R behind the best value.
        if (risk > 0 && position.stop !== null) {
          const gain = position.highWater - position.entry;
          let stop = position.stop;
          if (gain >= risk) stop = Math.max(stop, position.entry + Math.min(risk * 0.1, gain * 0.1));
          if (gain >= risk * 1.5) stop = Math.max(stop, position.highWater - risk * 0.75);
          if (stop > position.stop) { position.stop = round2(stop); position.trailing = true; this.persist(position); }
        }
        const spotPrice = input.spot;
        const bull = position.side === "CE";
        if (position.spot && (bull ? spotPrice <= position.spot.stop : spotPrice >= position.spot.stop)) reason = "SPOT_LEVEL_BROKEN";
        else if (position.spot && (bull ? spotPrice >= position.spot.target : spotPrice <= position.spot.target)) reason = "SPOT_TARGET";
        else if (position.target !== null && value >= position.target) reason = "TARGET";
        else if (position.stop !== null && value <= position.stop) reason = position.trailing ? "TRAILING_STOP" : "STOP_LOSS";
        else if (position.kind === "SCALP" && risk > 0 && now.getTime() - Date.parse(position.openedAt) >= settings.maxHoldMinutes * 60_000 && value - position.entry < risk * 0.5) reason = "SCALP_TIME_STOP";
      }
      if (reason) this.close(position, reason);
    }
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
        id: leg.orderId, referenceId: position.id, strategy: STRATEGY_ID, strategyName: `Smart Scalper · ${position.kind}`, underlying: position.underlying,
        symbol: leg.symbol, growwSymbol: leg.symbol, expiry: leg.expiry, strike: leg.strike, side: leg.side, quantity: leg.quantity, lotSize: leg.quantity,
        price: leg.entry, currentPrice: leg.ltp, pnl: round2(legPnl),
        ...(position.legs.length === 1 && position.stop !== null ? { stopLoss: position.stop, target: position.target ?? undefined, trailingStop: position.trailing ? position.stop : undefined } : {}),
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
      if (weekday === 0 || weekday === 6 || istMinutes(now) < MARKET_OPEN || istMinutes(now) >= SQUARE_OFF) return { ...this.state(underlying), error: "Scalper entries are open 09:15-15:15 IST on trading days." };
      const qty = Math.max(1, Math.floor(lots)) * Math.max(1, contract.lotSize);
      const fill = this.fill(contract.ask > 0 ? contract.ask : contract.premium, "BUY", contract.tickSize || 0.05);
      const existing = this.positions.find((position) => position.status === "OPEN" && position.legs.length === 1 && norm(position.legs[0].symbol) === norm(contract.symbol) && position.legs[0].side === "BUY");
      if (existing) {
        const leg = existing.legs[0];
        leg.entry = round2((leg.entry * leg.quantity + fill * qty) / (leg.quantity + qty));
        leg.quantity += qty;
        leg.ltp = contract.premium;
        existing.entry = leg.entry;
        this.persist(existing);
        return { ...this.state(underlying), summary: `Added ${qty} ${contract.symbol} @ ${fill}; avg ${leg.entry}` };
      }
      const id = `scalper-${this.tradeDate}-${++this.sequence}-${Date.now().toString(36)}`;
      const position: ScalperPosition = {
        id, kind: "MANUAL", side: contract.contract === "CALL" ? "CE" : "PE", underlying, openedAt: this.clock().toISOString(), entry: fill, stop: null, target: null, initialRisk: null, highWater: fill, trailing: false, spot: null, reason: "Manual scalper order", status: "OPEN",
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

  snapshot(underlying: string) {
    return this.serial(async () => { await this.hydrate(); this.rollDay(); return { ...this.state(underlying), decision: this.lastDecision, summary: "" }; });
  }

  private view(position: ScalperPosition): PositionView {
    const quantity = this.quantity(position);
    const value = position.status === "OPEN" ? this.netValue(position) : position.exitValue ?? this.netValue(position);
    const label = position.legs.length === 1 ? position.legs[0].symbol : `${position.side === "CE" ? "Bull call" : "Bear put"} ${position.legs.map((leg) => leg.strike).join("/")}`;
    return { ...position, legs: position.legs.map((leg) => ({ ...leg })), quantity, value, pnl: position.status === "OPEN" ? round2((value - position.entry) * quantity) : position.realizedPnl ?? 0, label };
  }

  state(underlying?: string) {
    const views = this.positions.filter((position) => !underlying || position.underlying === underlying || position.underlying === "").map((position) => this.view(position));
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
