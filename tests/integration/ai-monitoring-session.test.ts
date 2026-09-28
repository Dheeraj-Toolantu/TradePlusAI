import { beforeEach, describe, expect, it } from "vitest";
import { MonitoringService, resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

describe("AI monitoring session lifecycle", () => {
  let service: MonitoringService;

  beforeEach(() => { service = resetMonitoringService(); });

  it("records actor and scope for an active session", () => {
    const session = service.enable({ ownerId: "user-1", symbols: ["NIFTY", "SENSEX"], timeframes: ["5m"], mode: "PAPER", strategyVersion: "v5-paper", confidenceThreshold: 70, automationEnabled: false, riskAcknowledged: true });
    expect(session).toMatchObject({ state: "ACTIVE", ownerId: "user-1", health: { blockers: [] } });
    expect(service.getConfiguration(session.configurationId)).toMatchObject({ instruments: ["NIFTY", "SENSEX"], automationEnabled: false });
    expect(service.audit.list(session.correlationId)).toHaveLength(1);
  });

  it("does not permit automation after a stop", () => {
    const session = service.enable({ ownerId: "user-1", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", strategyVersion: "v5-paper", confidenceThreshold: 70, automationEnabled: false, riskAcknowledged: true });
    service.disable("user-1", session.id, "Kill switch activated");
    expect(() => service.setAutomation("user-1", session.id, true, "PAPER")).toThrow("Monitoring session is not active");
  });
});
