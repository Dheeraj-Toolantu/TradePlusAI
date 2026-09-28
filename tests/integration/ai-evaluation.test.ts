import { beforeEach, describe, expect, it } from "vitest";
import { MonitoringService, resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";
import type { ModelGateway, ModelEvaluationRequest, ModelEvaluationResponse } from "../../services/ai-monitoring/src/model-gateway";

const gatewayResponse: ModelEvaluationResponse = { schemaVersion: "ai-trading-evaluation.v1", providerRequestId: "provider-1", modelAlias: "test-model", direction: "BULLISH", confidence: 82, evidence: [{ source: "trend", observation: "Higher highs", supports: "BULLISH" }], explanation: "Trend and volume align.", invalidation: "Close below support.", warnings: [], latencyMs: 5 };
const gateway = (response: ModelEvaluationResponse): ModelGateway => ({ evaluate: async (_request: ModelEvaluationRequest) => response, status: () => ({ providerAlias: "test", modelAlias: "test-model", state: "READY" }) });
const enable = (service: MonitoringService) => service.enable({ ownerId: "user-1", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", strategyVersion: "v5-paper", confidenceThreshold: 70, automationEnabled: false, riskAcknowledged: true });

describe("AI evaluation", () => {
  let service: MonitoringService;
  beforeEach(() => { service = resetMonitoringService(); });

  it("creates an explainable advisory suggestion from fresh context", async () => {
    const session = enable(service);
    const result = await service.evaluate("user-1", session.id, { instrumentId: "nifty", symbol: "NIFTY", timeframe: "5m", candles: [{ timestamp: "2026-09-20T09:20:00.000Z", open: 100, high: 105, low: 99, close: 104, volume: 1000 }], analysisId: "analysis-1", analysis: { status: "CONFIRMED", trend: "UPTREND" }, marketEvidence: { volume: "SUPPORTIVE" } }, gateway(gatewayResponse));
    expect(result.evaluation).toMatchObject({ state: "COMPLETED", direction: "BULLISH", confidence: 82 });
    expect(result.suggestion).toMatchObject({ direction: "BULLISH", status: "ADVISORY" });
    expect(result.automationDecision).toBeUndefined();
  });

  it("keeps deterministic blockers visible instead of enabling automation", async () => {
    const session = enable(service);
    const result = await service.evaluate("user-1", session.id, { instrumentId: "nifty", symbol: "NIFTY", timeframe: "5m", candles: [{ timestamp: "2026-09-20T09:20:00.000Z", open: 100, high: 105, low: 99, close: 104, volume: 1000 }], analysisId: "analysis-1", analysis: { status: "NO_TRADE", blockers: ["minimum_rr"] }, marketEvidence: {} }, gateway(gatewayResponse));
    expect(result.suggestion.status).toBe("ADVISORY");
    expect(result.evaluation.explanation).toContain("Trend");
  });
});
