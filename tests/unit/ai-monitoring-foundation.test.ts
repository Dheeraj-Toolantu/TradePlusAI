import { describe, expect, it } from "vitest";
import { InMemorySuggestionLogRepository } from "../../services/ai-monitoring/src/suggestion-log-repository";
import { validateModelEvaluationResponse } from "../../services/ai-monitoring/src/model-gateway-validator";
import type { AISuggestionLogEntry } from "../../packages/domain-contracts/src/ai-trading";

describe("AI monitoring foundation", () => {
  it("rejects unsafe model output and forbidden execution fields", () => {
    expect(() => validateModelEvaluationResponse({
      schemaVersion: "ai-trading-evaluation.v1",
      providerRequestId: "provider-1",
      modelAlias: "test-model",
      direction: "BULLISH",
      confidence: 101,
      evidence: [],
      explanation: "guaranteed profit",
      invalidation: "none",
      warnings: [],
      latencyMs: 2,
      quantity: 100,
    })).toThrow();
  });

  it("preserves append-only log entries", () => {
    const repository = new InMemorySuggestionLogRepository();
    const entry: AISuggestionLogEntry = {
      id: "log-1",
      eventType: "EVALUATION_COMPLETED",
      subjectId: "suggestion-1",
      correlationId: "correlation-1",
      summary: { symbol: "NIFTY", direction: "BULLISH", status: "ADVISORY" },
      detailRefs: { evaluationId: "evaluation-1" },
      actor: "SYSTEM",
      occurredAt: "2026-09-20T09:20:00.000Z",
    };
    repository.append(entry);
    expect(() => repository.replace("log-1", { ...entry, actor: "USER" })).toThrow();
    expect(repository.list({ subjectId: "suggestion-1" })).toEqual([entry]);
  });
});
