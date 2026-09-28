import { describe, expect, it } from "vitest";
import { evaluateAutomationDecision } from "../../services/ai-monitoring/src/automation-decision-service";

const valid = { suggestionId: "suggestion-1", evaluationId: "evaluation-1", analysisId: "analysis-1", mode: "PAPER" as const, direction: "BULLISH" as const, confidence: 90, contextFresh: true, deterministicConfirmed: true, sessionOpen: true, contractValid: true, liquidityAcceptable: true, riskAllowed: true, brokerHealthy: true, reconciled: true, safeMode: false, killSwitch: false, liveReleaseReady: false, idempotencyKey: "NIFTY:setup-1:BULLISH:window-1" };

describe("AI paper automation", () => {
  it.each([
    ["qualified", valid, "ALLOW_PAPER"],
    ["stale", { ...valid, contextFresh: false }, "BLOCK"],
    ["low RR", { ...valid, riskAllowed: false }, "BLOCK"],
    ["invalid contract", { ...valid, contractValid: false }, "BLOCK"],
    ["kill switch", { ...valid, killSwitch: true }, "BLOCK"],
    ["reconciliation", { ...valid, reconciled: false }, "BLOCK"],
  ])("maps %s to a safe paper decision", (_name, value, decision) => { expect(evaluateAutomationDecision(value).decision).toBe(decision); });
});
