import { beforeEach, describe, expect, it } from "vitest";
import { GET as getLogDetail } from "../../apps/web/app/api/ai-monitoring/log/[id]/route";
import { getMonitoringService, resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

describe("AI suggestion log access", () => {
  beforeEach(() => resetMonitoringService());

  it("does not expose another user's log record", async () => {
    getMonitoringService().logs.append({ id: "private-log", eventType: "EVALUATION_COMPLETED", subjectId: "suggestion-private", correlationId: "corr-private", summary: { symbol: "SENSEX", direction: "NEUTRAL", status: "BLOCKED" }, detailRefs: { evaluationId: "eval-private" }, actor: "user-owner", occurredAt: "2026-09-20T09:00:00.000Z" });
    const response = await getLogDetail(new Request("http://localhost/api/ai-monitoring/log/private-log", { headers: { "x-user-id": "user-other" } }), { params: Promise.resolve({ id: "private-log" }) });
    expect(response.status).toBe(403);
  });
});
