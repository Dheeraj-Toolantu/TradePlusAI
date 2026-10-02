import type { StrategySignal, AutoTraderRiskSnapshot } from "../../paper-trading/src/auto-option-trader";
import type { OptionAdvice } from "./option-advisor";

/**
 * Gatekeeper between an AI suggestion and a PAPER order. Every check is deterministic; the model
 * can only propose. A suggestion becomes an order only when it is fresh, confident, aligned across
 * timeframes, still at the planned price, and the trader's daily risk budget allows another trade.
 */
export type AutoTradeLimits = {
  maxTradesPerDay: number;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  maxOpenPositions: number;
  maxAdviceAgeMs: number;
  lots: number;
};

export const DEFAULT_AUTOTRADE_LIMITS: AutoTradeLimits = {
  maxTradesPerDay: 3,
  maxDailyLoss: 3000,
  maxConsecutiveLosses: 2,
  cooldownMinutes: 15,
  maxOpenPositions: 1,
  maxAdviceAgeMs: 90_000,
  lots: 1,
};

export function autoTradeLimitsFromEnv(env: Record<string, string | undefined> = process.env): AutoTradeLimits {
  const pick = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    maxTradesPerDay: pick("AI_AUTOTRADE_MAX_TRADES", DEFAULT_AUTOTRADE_LIMITS.maxTradesPerDay, 1, 10),
    maxDailyLoss: pick("AI_AUTOTRADE_MAX_DAILY_LOSS", DEFAULT_AUTOTRADE_LIMITS.maxDailyLoss, 100, 1_000_000),
    maxConsecutiveLosses: pick("AI_AUTOTRADE_MAX_CONSECUTIVE_LOSSES", DEFAULT_AUTOTRADE_LIMITS.maxConsecutiveLosses, 1, 10),
    cooldownMinutes: pick("AI_AUTOTRADE_COOLDOWN_MIN", DEFAULT_AUTOTRADE_LIMITS.cooldownMinutes, 0, 240),
    maxOpenPositions: 1,
    maxAdviceAgeMs: DEFAULT_AUTOTRADE_LIMITS.maxAdviceAgeMs,
    lots: pick("AI_AUTOTRADE_LOTS", DEFAULT_AUTOTRADE_LIMITS.lots, 1, 10),
  };
}

export type AutoTradeContext = {
  symbol: string;
  advice: OptionAdvice;
  adviceAgeMs: number;
  adviceSpot: number;
  liveSpot: number;
  /** Live premium of the advised contract, if it is on the chain. */
  livePremium: number | null;
  confidenceThreshold: number;
  risk: AutoTraderRiskSnapshot;
  limits: AutoTradeLimits;
  killSwitch: boolean;
  safeMode: boolean;
  now?: Date;
};

export type AutoTradeVerdict = { allowed: boolean; reasons: string[]; signal?: StrategySignal };

export function evaluateAutoTrade(context: AutoTradeContext): AutoTradeVerdict {
  const { advice, risk, limits } = context;
  const now = context.now ?? new Date();
  const reasons: string[] = [];
  if (context.killSwitch) reasons.push("Kill switch is active");
  if (context.safeMode) reasons.push("Safe mode is active");
  if (advice.action === "WAIT" || !advice.contract || !advice.spot || !advice.premium) reasons.push(`AI says WAIT: ${advice.headline}`);
  if (advice.blockedBy.length) reasons.push(...advice.blockedBy);
  if (advice.confidence < context.confidenceThreshold) reasons.push(`Confidence ${advice.confidence}% is below the ${context.confidenceThreshold}% threshold`);
  if (context.adviceAgeMs > limits.maxAdviceAgeMs) reasons.push("Suggestion is stale; waiting for a fresh read");
  if (advice.mtf && advice.action !== "WAIT") {
    const wanted = advice.action === "BUY_CE" ? "BULLISH_ALIGNED" : "BEARISH_ALIGNED";
    if (advice.mtf.alignment !== wanted) reasons.push(`Timeframes are ${advice.mtf.alignment.replaceAll("_", " ").toLowerCase()}, auto-trade needs ${wanted.replaceAll("_", " ").toLowerCase()}`);
  }
  if (risk.openPositions >= limits.maxOpenPositions) reasons.push("An AI position is already open");
  if (risk.tradesToday >= limits.maxTradesPerDay) reasons.push(`Daily trade limit reached (${risk.tradesToday}/${limits.maxTradesPerDay})`);
  if (risk.realizedPnlToday <= -limits.maxDailyLoss) reasons.push(`Daily loss limit reached (₹${Math.abs(risk.realizedPnlToday)} of ₹${limits.maxDailyLoss}); auto-trading stops for the day`);
  if (risk.consecutiveLosses >= limits.maxConsecutiveLosses) reasons.push(`${risk.consecutiveLosses} losses in a row: stop trading for the day and review`);
  if (risk.lastLossExitAt && limits.cooldownMinutes > 0) {
    const sinceLossMin = (now.getTime() - Date.parse(risk.lastLossExitAt)) / 60_000;
    if (sinceLossMin < limits.cooldownMinutes) reasons.push(`Cooling down after a loss (${Math.ceil(limits.cooldownMinutes - sinceLossMin)} min left)`);
  }
  if (advice.spot && advice.action !== "WAIT") {
    const riskPoints = Math.abs(advice.spot.entryHigh - advice.spot.stop) || Math.abs(advice.spot.entryLow - advice.spot.stop);
    const direction = advice.action === "BUY_CE" ? 1 : -1;
    const drift = (context.liveSpot - context.adviceSpot) * direction;
    if (riskPoints > 0 && drift > 0.5 * riskPoints) reasons.push(`Price already moved ${drift.toFixed(1)} pts in the trade direction (>0.5R): not chasing`);
    if ((context.liveSpot - advice.spot.stop) * direction <= 0) reasons.push("Price is already through the planned stop");
  }
  if (advice.premium && context.livePremium !== null && advice.premium.entry > 0) {
    const premiumMove = (context.livePremium - advice.premium.entry) / advice.premium.entry;
    if (premiumMove > 0.1) reasons.push(`Premium is ${(premiumMove * 100).toFixed(0)}% above the planned entry: not chasing`);
    if (context.livePremium <= advice.premium.stop) reasons.push("Premium is already at or below the planned stop");
  }
  if (advice.premium && context.livePremium === null) reasons.push("Advised contract has no live quote on the chain");
  if (reasons.length || !advice.contract || !advice.spot || !advice.premium) return { allowed: false, reasons };

  const signal: StrategySignal = {
    id: `AI:${context.symbol}:${advice.action}:${advice.contract.trading_symbol}:${advice.spot.stop}`,
    strategy: `AI Monitor · ${advice.strategy}`,
    side: advice.action === "BUY_CE" ? "BUY" : "SELL",
    entry: advice.action === "BUY_CE" ? advice.spot.entryHigh : advice.spot.entryLow,
    stopLoss: advice.spot.stop,
    target: advice.spot.target1,
    reason: `${advice.confidence}% · ${advice.headline}`,
    preferredSymbol: advice.contract.trading_symbol,
    ignoreMarketBias: true,
    premium: { stop: advice.premium.stop, target: advice.premium.target1 },
    lots: limits.lots,
  };
  return { allowed: true, reasons: [], signal };
}
