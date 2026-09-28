import { describe, expect, it } from "vitest";
import { evaluateAutomationDecision } from "../../services/ai-monitoring/src/automation-decision-service";
import type { AutomationDecisionInput } from "../../services/ai-monitoring/src/automation-decision-service";

const baseInput = (mode: "PAPER" | "ASSISTED" | "ALGO_LIVE"): AutomationDecisionInput => ({
  suggestionId: "suggestion-1",
  evaluationId: "evaluation-1",
  analysisId: "analysis-1",
  mode,
  direction: "BULLISH",
  confidence: 82,
  contextFresh: true,
  deterministicConfirmed: true,
  sessionOpen: true,
  contractValid: true,
  liquidityAcceptable: true,
  riskAllowed: true,
  brokerHealthy: true,
  reconciled: true,
  safeMode: false,
  killSwitch: false,
  liveReleaseReady: false,
  idempotencyKey: "NIFTY:setup-1:BULLISH:2026-09-20T09:20",
});

describe("AI automation decision", () => {
  it("allows qualified paper simulation only", () => {
    expect(evaluateAutomationDecision(baseInput("PAPER"))).toMatchObject({ decision: "ALLOW_PAPER" });
  });

  it("requires confirmation in assisted mode", () => {
    expect(evaluateAutomationDecision(baseInput("ASSISTED"))).toMatchObject({ decision: "REQUIRE_CONFIRMATION" });
  });

  it("blocks live mode until release readiness is complete", () => {
    expect(evaluateAutomationDecision(baseInput("ALGO_LIVE"))).toMatchObject({ decision: "BLOCK" });
  });

  it("blocks when deterministic safety fails", () => {
    expect(evaluateAutomationDecision({ ...baseInput("PAPER"), contextFresh: false })).toMatchObject({ decision: "BLOCK" });
  });
});
