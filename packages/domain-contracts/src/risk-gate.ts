import type { Decision, Freshness, Identifier, Mode } from "./primitives";

export type RiskGateInput = {
  signalId: Identifier;
  mode: Mode;
  capital: number;
  riskPercent: number;
  entry: number;
  stop: number;
  target: number;
  candidateQuantity: number;
  lotSize: number;
  dailyLoss: number;
  maxDailyLoss: number;
  openPositions: number;
  maxOpenPositions: number;
  tradesToday: number;
  maxTradesToday: number;
  minRiskReward: number;
  marketFreshness: Freshness;
  killSwitch: boolean;
};

export type RiskCheck = { name: string; observed: number | string | boolean; threshold?: number | string | boolean; result: boolean; reason: string };
export type RiskGateOutput = { decision: Decision; checks: RiskCheck[]; normalizedQuantity: number | null; maxLoss: number | null; expectedReward: number | null; riskReward: number | null; configurationVersion: string };