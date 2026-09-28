import { describe, expect, it } from "vitest";
import { evaluateAutomationDecision } from "../../services/ai-monitoring/src/automation-decision-service";
import { POST } from "../../apps/web/app/api/algo-trading/route";

const input = (mode: "ASSISTED" | "ALGO_LIVE") => ({ suggestionId: "suggestion-1", evaluationId: "evaluation-1", analysisId: "analysis-1", mode, direction: "BEARISH" as const, confidence: 84, contextFresh: true, deterministicConfirmed: true, sessionOpen: true, contractValid: true, liquidityAcceptable: true, riskAllowed: true, brokerHealthy: true, reconciled: true, safeMode: false, killSwitch: false, liveReleaseReady: false, idempotencyKey: "NIFTY:setup-1:BEARISH:window-1" });

describe("AI execution modes", () => {
  it("requires confirmation for ASSISTED", () => { expect(evaluateAutomationDecision(input("ASSISTED")).decision).toBe("REQUIRE_CONFIRMATION"); });
  it("keeps the existing live block", async () => {
    const response = await POST(new Request("http://localhost/api/algo-trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "ALGO_LIVE", confirmLive: true }) }));
    expect(response.status).toBe(403);
  });
});
