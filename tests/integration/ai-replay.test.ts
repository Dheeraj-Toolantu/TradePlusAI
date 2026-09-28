import { describe, expect, it } from "vitest";
import { MonitoringService } from "../../services/ai-monitoring/src/monitoring-service";
import type { ModelGateway } from "../../services/ai-monitoring/src/model-gateway";

const gateway: ModelGateway = { evaluate: async () => ({ schemaVersion: "ai-trading-evaluation.v1", providerRequestId: "provider-1", modelAlias: "test-model", direction: "BEARISH", confidence: 81, evidence: [{ source: "structure", observation: "Lower lows", supports: "BEARISH" }], explanation: "Structure is bearish.", invalidation: "Close above resistance.", warnings: [], latencyMs: 1 }), status: () => ({ providerAlias: "test", modelAlias: "test-model", state: "READY" }) };
const context = { instrumentId: "banknifty", symbol: "BANKNIFTY", timeframe: "5m", candles: [{ timestamp: "2026-09-20T09:20:00.000Z", open: 100, high: 101, low: 95, close: 96, volume: 1000 }], analysisId: "analysis-1", analysis: { status: "CONFIRMED", trend: "DOWNTREND" }, marketEvidence: { volume: "SUPPORTIVE" } };

describe("AI evaluation replay", () => {
  it("returns the same validated suggestion category for identical inputs", async () => {
    const first = new MonitoringService();
    const firstSession = first.enable({ ownerId: "user-1", symbols: ["BANKNIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true });
    const second = new MonitoringService();
    const secondSession = second.enable({ ownerId: "user-1", symbols: ["BANKNIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true });
    const left = await first.evaluate("user-1", firstSession.id, context, gateway);
    const right = await second.evaluate("user-1", secondSession.id, context, gateway);
    expect({ direction: left.evaluation.direction, status: left.suggestion.status }).toEqual({ direction: right.evaluation.direction, status: right.suggestion.status });
  });
});
