import type { Decision, Identifier, IsoTimestamp, Mode } from "./primitives";

export const ALGO_FLOW_STAGES = ["NEWS", "REGIME", "TECHNICAL", "OPTIONS", "LIQUIDITY", "RR", "RISK", "EXECUTION"] as const;
export type AlgoFlowStage = (typeof ALGO_FLOW_STAGES)[number];
export type GateResult = { stage: AlgoFlowStage; observedValue: unknown; threshold?: unknown; passed: boolean; evidence?: unknown; reason?: string; evaluatedAt: IsoTimestamp };
export type AlgoFlowEvaluation = { id: Identifier; candidateId: Identifier; correlationId: Identifier; mode: Mode; broker: string; currentStage: AlgoFlowStage; finalDecision: Decision | "COMPLETED"; gateResults: GateResult[]; startedAt: IsoTimestamp; completedAt?: IsoTimestamp };