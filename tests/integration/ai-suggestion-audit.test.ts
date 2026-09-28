import { describe, expect, it } from "vitest";
import { InMemorySuggestionLogRepository } from "../../services/ai-monitoring/src/suggestion-log-repository";

describe("AI suggestion audit persistence", () => {
  it("keeps the original evaluation evidence when later lifecycle events are appended", () => {
    const repository = new InMemorySuggestionLogRepository();
    repository.append({ id: "evaluation-event", eventType: "EVALUATION_COMPLETED", subjectId: "suggestion-1", correlationId: "corr-1", summary: { symbol: "BANKNIFTY", direction: "BEARISH", status: "CONFIRMED", confidence: 84, evidence: "lower lows" }, detailRefs: { evaluationId: "evaluation-1" }, actor: "user-1", occurredAt: "2026-09-20T09:00:00.000Z" });
    repository.append({ id: "invalidated-event", eventType: "SUGGESTION_INVALIDATED", subjectId: "suggestion-1", correlationId: "corr-1", summary: { symbol: "BANKNIFTY", direction: "BEARISH", status: "INVALIDATED" }, detailRefs: { evaluationId: "evaluation-1" }, actor: "SYSTEM", occurredAt: "2026-09-20T09:05:00.000Z" });
    expect(repository.get("evaluation-event")?.summary).toMatchObject({ evidence: "lower lows", status: "CONFIRMED" });
    expect(repository.list({ subjectId: "suggestion-1" })).toHaveLength(2);
  });
});
