import { beforeEach, describe, expect, it, vi } from "vitest";

const runPythonModule = vi.fn();
vi.mock("../../apps/web/lib/python", () => ({ runPythonModule: (...args: unknown[]) => runPythonModule(...args) }));

import { GET as sentimentGet } from "../../apps/web/app/api/sentiment/route";
import { POST as autotradePost, GET as autotradeGet } from "../../apps/web/app/api/ai-monitoring/autotrade/route";
import { resetMonitoringService } from "../../services/ai-monitoring/src/monitoring-service";

const scan = (score: number) => ({ generated_at: new Date().toISOString(), summary: { india: { score, label: "BULLISH", items: 5, bullish_pct: 60, bearish_pct: 20 } }, event_risk: [], sources: [], top_bullish: [], top_bearish: [], global_headlines: [] });

describe("sentiment refresh", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__tradepulseSentiment = null;
    runPythonModule.mockReset();
  });
  it("serves the cached scan normally and re-scans on ?refresh=1 once the minimum interval passed", async () => {
    runPythonModule.mockResolvedValueOnce(scan(10)).mockResolvedValueOnce(scan(25));
    expect((await (await sentimentGet(new Request("http://localhost/api/sentiment"))).json()).summary.india.score).toBe(10);
    expect((await (await sentimentGet(new Request("http://localhost/api/sentiment"))).json()).summary.india.score).toBe(10);
    // Cached within the last minute: a manual refresh does not hammer the feeds.
    expect((await (await sentimentGet(new Request("http://localhost/api/sentiment?refresh=1"))).json()).summary.india.score).toBe(10);
    expect(runPythonModule).toHaveBeenCalledTimes(1);
    (globalThis as { __tradepulseSentiment?: { at: number } }).__tradepulseSentiment!.at -= 61_000;
    expect((await (await sentimentGet(new Request("http://localhost/api/sentiment?refresh=1"))).json()).summary.india.score).toBe(25);
    expect(runPythonModule).toHaveBeenCalledTimes(2);
  });
});

describe("AI auto-trade route", () => {
  beforeEach(() => { resetMonitoringService(); });
  const post = (body: Record<string, unknown>, headers: Record<string, string> = { "x-user-id": "user-1" }) => autotradePost(new Request("http://localhost/api/ai-monitoring/autotrade", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  it("requires a user", async () => {
    expect((await post({ symbol: "NIFTY" }, {})).status).toBe(401);
  });
  it("refuses entries until monitoring and auto-trade are enabled", async () => {
    const response = await post({ symbol: "NIFTY", sessionId: "missing" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Enable AI monitoring/);
    const service = resetMonitoringService();
    const session = service.enable({ ownerId: "user-1", symbols: ["NIFTY"], timeframes: ["5m"], mode: "PAPER", riskAcknowledged: true });
    const off = await post({ symbol: "NIFTY", sessionId: session.id });
    expect(off.status).toBe(409);
    expect((await off.json()).error).toMatch(/switched off/);
  });
  it("reports paper-mode status and limits", async () => {
    const body = await (await autotradeGet(new Request("http://localhost/api/ai-monitoring/autotrade?sessionId=x", { headers: { "x-user-id": "user-1" } }))).json();
    expect(body).toMatchObject({ mode: "PAPER", automationEnabled: false, limits: { maxTradesPerDay: 3, maxDailyLoss: 3000, lots: 1 } });
  });
});
