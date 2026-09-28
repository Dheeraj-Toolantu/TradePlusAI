import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../apps/web/app/api/ai-monitoring/route";
import { resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

const requestFor = (body: Record<string, unknown>, headers: Record<string, string> = { "x-user-id": "user-1" }) => new Request("http://localhost/api/ai-monitoring", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("AI monitoring route", () => {
  beforeEach(() => resetMonitoringService());

  it("requires an authenticated user", async () => {
    const response = await POST(requestFor({ action: "ENABLE_MONITORING", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER" }, {}));
    expect(response.status).toBe(401);
  });

  it("enables monitoring without enabling automation", async () => {
    const response = await POST(requestFor({ action: "ENABLE_MONITORING", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", strategyVersion: "v5-paper", confidenceThreshold: 70, automationEnabled: false, riskAcknowledged: true }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ state: "ACTIVE", monitoringEnabled: true, automationEnabled: false, mode: "PAPER" });
    const status = await GET(new Request("http://localhost/api/ai-monitoring", { headers: { "x-user-id": "user-1" } }));
    await expect(status.json()).resolves.toMatchObject({ monitoring: { monitoringEnabled: true, automationEnabled: false } });
  });

  it("rejects unsupported symbols", async () => {
    const response = await POST(requestFor({ action: "ENABLE_MONITORING", symbols: ["RELIANCE"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true }));
    expect(response.status).toBe(400);
  });

  it("stops monitoring and records the reason", async () => {
    const enabled = await POST(requestFor({ action: "ENABLE_MONITORING", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true }));
    const sessionId = (await enabled.json()).sessionId;
    const response = await POST(requestFor({ action: "DISABLE_MONITORING", sessionId, reason: "User stopped monitoring" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ state: "STOPPED", reason: "User stopped monitoring" });
  });
});
