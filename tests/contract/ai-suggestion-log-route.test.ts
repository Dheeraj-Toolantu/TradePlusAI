import { beforeEach, describe, expect, it } from "vitest";
import { GET as getMonitoring, POST } from "../../apps/web/app/api/ai-monitoring/route";
import { GET as getLogDetail } from "../../apps/web/app/api/ai-monitoring/log/[id]/route";
import { getMonitoringService, resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

const request = (url: string) => new Request(`http://localhost${url}`, { headers: { "x-user-id": "user-1" } });
const enable = () => POST(new Request("http://localhost/api/ai-monitoring", { method: "POST", headers: { "content-type": "application/json", "x-user-id": "user-1" }, body: JSON.stringify({ action: "ENABLE_MONITORING", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true }) }));

describe("AI suggestion log contract", () => {
  beforeEach(() => resetMonitoringService());

  it("returns newest-first filtered log entries and totals", async () => {
    await enable();
    const service = getMonitoringService();
    service.logs.append({ id: "log-old", eventType: "EVALUATION_COMPLETED", subjectId: "suggestion-old", correlationId: "corr-old", summary: { symbol: "NIFTY", direction: "BEARISH", status: "BLOCKED", confidence: 40 }, detailRefs: { evaluationId: "eval-old" }, actor: "user-1", occurredAt: "2026-09-20T09:00:00.000Z" });
    service.logs.append({ id: "log-new", eventType: "EVALUATION_COMPLETED", subjectId: "suggestion-new", correlationId: "corr-new", summary: { symbol: "NIFTY", direction: "BULLISH", status: "ADVISORY", confidence: 80 }, detailRefs: { evaluationId: "eval-new" }, actor: "user-1", occurredAt: "2026-09-20T09:10:00.000Z" });
    const response = await getMonitoring(request("/api/ai-monitoring?direction=BULLISH&limit=1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ log: { total: 1, items: [{ id: "log-new" }] } });
  });

  it("returns immutable detail without changing the stored record", async () => {
    await enable();
    const service = getMonitoringService();
    service.logs.append({ id: "log-detail", eventType: "EVALUATION_COMPLETED", subjectId: "suggestion-detail", correlationId: "corr-detail", summary: { symbol: "NIFTY", direction: "BULLISH", status: "ADVISORY" }, detailRefs: { evaluationId: "eval-detail" }, actor: "user-1", occurredAt: "2026-09-20T09:10:00.000Z" });
    const response = await getLogDetail(new Request("http://localhost/api/ai-monitoring/log/log-detail", { headers: { "x-user-id": "user-1" } }), { params: Promise.resolve({ id: "log-detail" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "log-detail", summary: { direction: "BULLISH" } });
    expect(service.logs.get("log-detail")?.summary.direction).toBe("BULLISH");
  });
});
