import { describe, expect, it } from "vitest";
import { AITradingAuditStore } from "../../services/audit/src/ai-trading-audit";

describe("AI observability redaction", () => {
  it("does not expose credentials in audit payloads", () => {
    const audit = new AITradingAuditStore();
    const record = audit.append({ action: "AI_EVALUATION_FAILED", objectType: "AIEvaluation", objectId: "evaluation-1", actor: "SYSTEM", mode: "PAPER", correlationId: "corr-1", payload: { failureCode: "TIMEOUT", providerAlias: "litellm" } });
    expect(JSON.stringify(record)).not.toContain("apiKey");
    expect(JSON.stringify(record)).not.toContain("Authorization");
  });
});
