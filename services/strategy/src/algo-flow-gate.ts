import type { RiskGateInput, RiskGateOutput } from "../../../packages/domain-contracts/src/risk-gate";
import { evaluateRisk } from "../../risk/src/risk-gate";

export type AlgoFlowInput = { newsImpact: number; minimumNewsImpact: number; regimeAllowed: boolean; technicalConfirmed: boolean; optionsConfirmed: boolean; liquidityConfirmed: boolean; risk: RiskGateInput };
export type AlgoFlowResult = { allowed: boolean; stage: "NEWS" | "REGIME" | "TECHNICAL" | "OPTIONS" | "LIQUIDITY" | "RR" | "RISK" | "EXECUTION"; reason?: string; risk?: RiskGateOutput };

export function evaluateAlgoFlow(input: AlgoFlowInput): AlgoFlowResult {
  if (input.newsImpact < input.minimumNewsImpact) return { allowed: false, stage: "NEWS", reason: "News impact is below the configured threshold." };
  if (!input.regimeAllowed) return { allowed: false, stage: "REGIME", reason: "Market regime does not allow this strategy." };
  if (!input.technicalConfirmed) return { allowed: false, stage: "TECHNICAL", reason: "Technical confirmation is missing." };
  if (!input.optionsConfirmed) return { allowed: false, stage: "OPTIONS", reason: "Options/OI confirmation is missing." };
  if (!input.liquidityConfirmed) return { allowed: false, stage: "LIQUIDITY", reason: "Liquidity confirmation is missing." };
  const risk = evaluateRisk(input.risk);
  if (risk.riskReward === null || risk.riskReward < input.risk.minRiskReward) return { allowed: false, stage: "RR", reason: "Minimum risk/reward requirement failed.", risk };
  if (risk.decision !== "ALLOW") return { allowed: false, stage: "RISK", reason: risk.checks.filter((check) => !check.result).map((check) => check.reason).join(" "), risk };
  return { allowed: true, stage: "EXECUTION", risk };
}