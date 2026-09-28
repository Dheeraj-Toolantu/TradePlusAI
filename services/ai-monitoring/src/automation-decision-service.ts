import type { AutomationDecision, AutomationDecisionType, GateResult } from "../../../packages/domain-contracts/src/ai-trading";
import type { Mode } from "../../../packages/domain-contracts/src/primitives";

export type AutomationDecisionInput = {
  suggestionId: string;
  evaluationId: string;
  analysisId: string;
  mode: Mode;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "NO_TRADE" | "WAITING";
  confidence: number;
  contextFresh: boolean;
  deterministicConfirmed: boolean;
  sessionOpen: boolean;
  contractValid: boolean;
  liquidityAcceptable: boolean;
  riskAllowed: boolean;
  brokerHealthy: boolean;
  reconciled: boolean;
  safeMode: boolean;
  killSwitch: boolean;
  liveReleaseReady: boolean;
  idempotencyKey: string;
};

function gate(name: string, passed: boolean, reason: string, observed?: unknown): GateResult {
  return { name, passed, reason, observed };
}

export function evaluateAutomationDecision(input: AutomationDecisionInput): AutomationDecision {
  const gates: GateResult[] = [
    gate("ai_confirmation", ["BULLISH", "BEARISH"].includes(input.direction) && input.confidence >= 70, "AI must provide a current bullish or bearish confirmation.", input.direction),
    gate("context_freshness", input.contextFresh, "Market context must be fresh."),
    gate("deterministic_confirmation", input.deterministicConfirmed, "Deterministic analysis must confirm the setup."),
    gate("session", input.sessionOpen, "Market session or entry window is not open."),
    gate("contract", input.contractValid, "Option contract metadata is invalid or unavailable."),
    gate("liquidity", input.liquidityAcceptable, "Liquidity requirements are not satisfied."),
    gate("risk", input.riskAllowed, "Risk gate rejected the setup."),
    gate("broker", input.brokerHealthy, "Broker health is not ready."),
    gate("reconciliation", input.reconciled, "Broker reconciliation is uncertain."),
    gate("safe_mode", !input.safeMode, "SAFE_MODE is active."),
    gate("kill_switch", !input.killSwitch, "Kill switch is active."),
    gate("live_release", input.mode !== "ALGO_LIVE" || input.liveReleaseReady, "ALGO_LIVE release readiness is incomplete."),
  ];
  const failed = gates.find((candidate) => !candidate.passed);
  let decision: AutomationDecisionType;
  if (failed) decision = "BLOCK";
  else if (input.mode === "PAPER") decision = "ALLOW_PAPER";
  else if (input.mode === "ASSISTED") decision = "REQUIRE_CONFIRMATION";
  else decision = "BLOCK";
  return {
    id: crypto.randomUUID(),
    suggestionId: input.suggestionId,
    evaluationId: input.evaluationId,
    analysisId: input.analysisId,
    mode: input.mode,
    decision,
    gates,
    idempotencyKey: input.idempotencyKey,
    reason: failed?.reason ?? (decision === "REQUIRE_CONFIRMATION" ? "User confirmation is required." : "All safety gates passed."),
    correlationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
}
