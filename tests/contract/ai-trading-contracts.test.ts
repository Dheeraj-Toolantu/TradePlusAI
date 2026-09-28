import { describe, expect, it } from "vitest";
import type { AIEvaluation, AISuggestion, AITradingConfiguration } from "../../packages/domain-contracts/src/ai-trading";
import { isUnsafeEvent } from "../../packages/event-schemas/src/events";

describe("AI trading contracts", () => {
  it("keeps monitoring and automation independent", () => {
    const configuration: AITradingConfiguration = {
      id: "config-1",
      ownerId: "user-1",
      monitoringEnabled: true,
      automationEnabled: false,
      mode: "PAPER",
      instruments: ["NIFTY"],
      timeframes: ["5m"],
      strategyVersion: "v5-paper",
      confidenceThreshold: 70,
      contextPolicy: { maxAgeSeconds: 30 },
      riskAcknowledged: true,
      version: "1",
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
    };
    expect(configuration.monitoringEnabled).toBe(true);
    expect(configuration.automationEnabled).toBe(false);
  });

  it("marks stale monitoring events unsafe", () => {
    expect(isUnsafeEvent({
      eventId: "event-1",
      eventType: "ai.evaluation.completed",
      schemaVersion: "1.0",
      occurredAt: "2026-09-20T09:00:00.000Z",
      receivedAt: "2026-09-20T09:00:00.000Z",
      mode: "PAPER",
      subjectType: "AIEvaluation",
      subjectId: "evaluation-1",
      freshness: "STALE",
      severity: "WARNING",
      payload: {},
    })).toBe(true);
  });

  it("represents a validated evaluation and suggestion", () => {
    const evaluation: AIEvaluation = {
      id: "evaluation-1",
      sessionId: "session-1",
      configurationId: "config-1",
      contextSnapshotId: "snapshot-1",
      correlationId: "correlation-1",
      providerRequestId: "provider-1",
      state: "COMPLETED",
      direction: "BULLISH",
      confidence: 80,
      evidence: [],
      explanation: "Trend and volume align.",
      invalidation: "Close below support.",
      model: { providerAlias: "test", modelAlias: "test", version: "1", schemaVersion: "ai-trading-evaluation.v1" },
      latencyMs: 10,
      createdAt: "2026-09-20T09:00:00.000Z",
      completedAt: "2026-09-20T09:00:00.010Z",
    };
    const suggestion: AISuggestion = {
      id: "suggestion-1",
      evaluationId: evaluation.id,
      analysisId: "analysis-1",
      direction: evaluation.direction,
      status: "ADVISORY",
      confidence: evaluation.confidence,
      reasonSummary: [evaluation.explanation],
      risks: [],
      invalidation: evaluation.invalidation,
      createdAt: evaluation.completedAt,
    };
    expect(suggestion.direction).toBe("BULLISH");
  });
});
