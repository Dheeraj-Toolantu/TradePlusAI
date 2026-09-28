import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../apps/web/app/api/ai-monitoring/route";
import { resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

const requestFor = (body: Record<string, unknown>) => new Request("http://localhost/api/ai-monitoring", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "user-1" }, body: JSON.stringify(body) });

describe("AI monitoring control security", () => {
  beforeEach(() => resetMonitoringService());

  it("rejects unavailable ALGO_LIVE activation", async () => {
    const response = await POST(requestFor({ action: "ENABLE_MONITORING", symbols: ["NIFTY"], timeframes: ["5m"], mode: "ALGO_LIVE", riskAcknowledged: true }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("ALGO_LIVE") });
  });

  it("ignores client attempts to change risk and kill switch controls", async () => {
    const response = await POST(requestFor({ action: "ENABLE_MONITORING", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true, killSwitch: false, riskLimits: { maxDailyLoss: 999999999 } }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.not.toHaveProperty("riskLimits");
  });
});
