import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../apps/web/app/api/ai-monitoring/route";
import { resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

describe("AI monitoring page read model", () => {
  beforeEach(() => resetMonitoringService());

  it("exposes mode, monitoring state, health, and blockers together", async () => {
    await POST(new Request("http://localhost/api/ai-monitoring", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "user-1" }, body: JSON.stringify({ action: "ENABLE_MONITORING", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true }) }));
    const response = await GET(new Request("http://localhost/api/ai-monitoring", { headers: { "x-user-id": "user-1" } }));
    const body = await response.json();
    expect(body.monitoring).toMatchObject({ mode: "PAPER", monitoringEnabled: true, automationEnabled: false });
    expect(body.health).toHaveProperty("blockers");
  });
});