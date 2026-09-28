import { describe, expect, it } from "vitest";
import { MonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

describe("AI monitoring recovery", () => {
  it("transitions through degraded and active only after recovery", () => {
    const service = new MonitoringService();
    const session = service.enable({ ownerId: "user-1", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true });
    service.degrade(session.id, "Provider unavailable");
    expect(service.getSession("user-1", session.id)).toMatchObject({ state: "DEGRADED", stopReason: "Provider unavailable" });
    service.recover(session.id);
    expect(service.getSession("user-1", session.id)).toMatchObject({ state: "ACTIVE" });
    expect(service.audit.list(session.correlationId).map((record) => record.action)).toEqual(["AI_MONITORING_ENABLED", "AI_MONITORING_DEGRADED", "AI_MONITORING_RECOVERED"]);
  });
});
