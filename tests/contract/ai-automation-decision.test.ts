import { describe, expect, it } from "vitest";
import { evaluateAutomationDecision } from "../../services/ai-monitoring/src/automation-decision-service";

const input = (mode: "PAPER" | "ASSISTED" | "ALGO_LIVE") => ({ suggestionId: "suggestion-1", evaluationId: "evaluation-1", analysisId: "analysis-1", mode, direction: "BULLISH" as const, confidence: 88, contextFresh: true, deterministicConfirmed: true, sessionOpen: true, contractValid: true, liquidityAcceptable: true, riskAllowed: true, brokerHealthy: true, reconciled: true, safeMode: false, killSwitch: false, liveReleaseReady: false, idempotencyKey: "NIFTY:setup-1:BULLISH:window-1" });

describe("AI automation decision contract", () => {
  it("requires every gate before paper allowance", () => {
    const result = evaluateAutomationDecision({ ...input("PAPER"), liquidityAcceptable: false });
    expect(result.decision).toBe("BLOCK");
    expect(result.gates.find((gate) => gate.name === "liquidity")?.passed).toBe(false);
  });

  it("returns mode-scoped decisions", () => {
    expect(evaluateAutomationDecision(input("PAPER")).decision).toBe("ALLOW_PAPER");
    expect(evaluateAutomationDecision(input("ASSISTED")).decision).toBe("REQUIRE_CONFIRMATION");
    expect(evaluateAutomationDecision(input("ALGO_LIVE")).decision).toBe("BLOCK");
  });
});
