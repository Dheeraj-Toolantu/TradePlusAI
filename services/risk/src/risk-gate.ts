import type { RiskGateInput, RiskGateOutput } from "../../../packages/domain-contracts/src/risk-gate";
import { calculateRisk } from "./risk-calculator";

export function evaluateRisk(input: RiskGateInput): RiskGateOutput {
  const calculation = calculateRisk(input.entry, input.stop, input.target, input.capital, input.riskPercent, input.candidateQuantity, input.lotSize);
  const checks = [
    { name: "minimum_rr", observed: calculation.riskReward ?? 0, threshold: input.minRiskReward, result: (calculation.riskReward ?? 0) >= input.minRiskReward, reason: "Expected reward must meet minimum risk/reward." },
    { name: "daily_loss", observed: input.dailyLoss, threshold: input.maxDailyLoss, result: input.dailyLoss < input.maxDailyLoss, reason: "Daily loss limit reached." },
    { name: "open_positions", observed: input.openPositions, threshold: input.maxOpenPositions, result: input.openPositions < input.maxOpenPositions, reason: "Maximum open positions reached." },
    { name: "trades_today", observed: input.tradesToday, threshold: input.maxTradesToday, result: input.tradesToday < input.maxTradesToday, reason: "Maximum trades per day reached." },
    { name: "market_freshness", observed: input.marketFreshness, threshold: "FRESH", result: input.marketFreshness === "FRESH", reason: "Market data is not fresh." },
    { name: "kill_switch", observed: input.killSwitch, threshold: false, result: !input.killSwitch, reason: "Kill switch is active." },
    { name: "valid_quantity", observed: calculation.normalizedQuantity, threshold: input.lotSize, result: calculation.normalizedQuantity > 0, reason: "No valid lot-sized quantity is available." },
  ];
  const passed = checks.every((check) => check.result);
  return { decision: passed ? "ALLOW" : "BLOCK", checks, normalizedQuantity: passed ? calculation.normalizedQuantity : null, maxLoss: calculation.maxLoss, expectedReward: calculation.expectedReward, riskReward: calculation.riskReward, configurationVersion: "risk-v1" };
}