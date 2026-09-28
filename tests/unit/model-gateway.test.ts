import { describe, expect, it } from "vitest";
import { validateModelEvaluationResponse } from "../../services/ai-monitoring/src/model-gateway-validator";

const response = {
  schemaVersion: "ai-trading-evaluation.v1",
  providerRequestId: "provider-1",
  modelAlias: "test-model",
  direction: "BULLISH",
  confidence: 78,
  evidence: [{ source: "trend", observation: "Higher highs", supports: "BULLISH" }],
  explanation: "Trend and volume align.",
  invalidation: "Close below support.",
  warnings: [],
  latencyMs: 8,
};

describe("model gateway validation", () => {
  it("accepts the bounded structured response", () => {
    expect(validateModelEvaluationResponse(response)).toMatchObject({ direction: "BULLISH", confidence: 78 });
  });

  it.each([
    ["timeout", { ...response, confidence: 101 }],
    ["malformed", { ...response, evidence: "not-an-array" }],
    ["unsupported instruction", { ...response, order: "BUY NIFTY" }],
    ["prohibited claim", { ...response, explanation: "Guaranteed profit" }],
  ])("rejects %s output", (_name, value) => {
    expect(() => validateModelEvaluationResponse(value)).toThrow();
  });
});
