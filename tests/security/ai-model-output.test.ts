import { describe, expect, it } from "vitest";
import { MonitoringService } from "../../services/ai-monitoring/src/monitoring-service";
import type { ModelGateway } from "../../services/ai-monitoring/src/model-gateway";

describe("AI model output boundary", () => {
  it("turns execution-shaped model output into a malformed evaluation", async () => {
    const service = new MonitoringService();
    const session = service.enable({ ownerId: "user-1", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true });
    const gateway: ModelGateway = { evaluate: async () => ({ schemaVersion: "ai-trading-evaluation.v1", providerRequestId: "provider-1", modelAlias: "test", direction: "BULLISH", confidence: 90, evidence: [], explanation: "Buy now", invalidation: "Close below support", warnings: [], latencyMs: 1, quantity: 100 }), status: () => ({ providerAlias: "test", modelAlias: "test", state: "READY" }) };
    const result = await service.evaluate("user-1", session.id, { instrumentId: "nifty", symbol: "NIFTY", timeframe: "5m", candles: [{ timestamp: "2026-09-20T09:20:00.000Z", open: 100, high: 105, low: 99, close: 104, volume: 1000 }], analysisId: "analysis-1", analysis: { status: "CONFIRMED" }, marketEvidence: {} }, gateway);
    expect(result.evaluation.state).toBe("MALFORMED");
    expect(result.automationDecision).toBeUndefined();
  });
});
