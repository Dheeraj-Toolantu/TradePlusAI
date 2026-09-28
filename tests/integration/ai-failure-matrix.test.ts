import { describe, expect, it } from "vitest";
import { MonitoringService } from "../../services/ai-monitoring/src/monitoring-service";
import type { ModelGateway } from "../../services/ai-monitoring/src/model-gateway";

const context = { instrumentId: "nifty", symbol: "NIFTY", timeframe: "5m", candles: [{ timestamp: "2026-09-20T09:20:00.000Z", open: 100, high: 105, low: 99, close: 104, volume: 1000 }], analysisId: "analysis-1", analysis: { status: "CONFIRMED" }, marketEvidence: {} };
const enabled = (service: MonitoringService) => service.enable({ ownerId: "user-1", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true });
const gateway = (evaluate: ModelGateway["evaluate"]): ModelGateway => ({ evaluate, status: () => ({ providerAlias: "test", modelAlias: "test", state: "READY" }) });

describe("AI failure matrix", () => {
  it("blocks stale context without a model call", async () => {
    const service = new MonitoringService(); const session = enabled(service);
    const result = await service.evaluate("user-1", session.id, { ...context, freshness: "STALE" }, gateway(async () => { throw new Error("must not call"); }));
    expect(result.evaluation.state).toBe("REJECTED");
    expect(result.suggestion.status).toBe("BLOCKED");
  });

  it("keeps provider timeout unavailable and non-actionable", async () => {
    const service = new MonitoringService(); const session = enabled(service);
    const result = await service.evaluate("user-1", session.id, context, gateway(async () => { throw new Error("timeout"); }));
    expect(result.evaluation.state).toBe("UNAVAILABLE");
    expect(result.suggestion.direction).toBe("UNAVAILABLE");
  });
});
