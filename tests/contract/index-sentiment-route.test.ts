import { beforeEach, describe, expect, it, vi } from "vitest";

const runPythonModule = vi.fn();
vi.mock("../../apps/web/lib/python", () => ({ runPythonModule: (...args: unknown[]) => runPythonModule(...args) }));

import { GET } from "../../apps/web/app/api/index-sentiment/route";

const scan = (score: number) => ({ generated_at: new Date().toISOString(), indices: [{ id: "NIFTY", score, constituents: [] }], market_context: null, sources: [], method: "" });
const commodities = { generated_at: new Date().toISOString(), commodities: [{ id: "CRUDEOIL", score: 30 }], notes: [], errors: [], method: "" };
/** Index scans resolve in order from `scans`; the commodity scan resolves (or fails) on its own. */
function engine(scans: Array<unknown>, commodityResult: Promise<unknown> = Promise.resolve(commodities)) {
  runPythonModule.mockImplementation((module: string) => module.endsWith("commodity_engine") ? commodityResult : scans.length ? Promise.resolve(scans.shift()) : Promise.reject(new Error("no scan")));
}
const indexCalls = () => runPythonModule.mock.calls.filter(([module]) => module === "tradepulse_quant.sentiment.index_engine").length;
const store = globalThis as { __tradepulseIndexSentiment?: { at: number } | null; __tradepulseSentiment?: unknown };

describe("index sentiment route", () => {
  beforeEach(() => {
    store.__tradepulseIndexSentiment = null;
    store.__tradepulseSentiment = { at: Date.now(), value: { composite: { overall: { score: -30 }, india: { score: -20 }, global: { score: -40 }, retail: { score: 10 } } } };
    runPythonModule.mockReset();
  });

  it("passes the cached macro backdrop to the engine and caches the scan", async () => {
    engine([scan(22), scan(-5)]);
    const first = await (await GET(new Request("http://localhost/api/index-sentiment"))).json();
    expect(first.indices[0].score).toBe(22);
    expect(first.commodities.commodities[0].id).toBe("CRUDEOIL");
    expect(runPythonModule).toHaveBeenCalledWith("tradepulse_quant.sentiment.index_engine", { market_context: { overall_score: -30, india_score: -20, global_score: -40, retail_score: 10, mmi_score: null, mmi_value: null } }, 90_000);
    // Within the minimum interval a manual refresh serves the cache.
    expect((await (await GET(new Request("http://localhost/api/index-sentiment?refresh=1"))).json()).indices[0].score).toBe(22);
    store.__tradepulseIndexSentiment!.at -= 3 * 60_000;
    expect((await (await GET(new Request("http://localhost/api/index-sentiment?refresh=1"))).json()).indices[0].score).toBe(-5);
    expect(indexCalls()).toBe(2);
  });

  it("keeps the index scan when the commodity scan fails", async () => {
    engine([scan(10)], Promise.reject(new Error("yahoo down")));
    const body = await (await GET(new Request("http://localhost/api/index-sentiment"))).json();
    expect(body.indices[0].score).toBe(10);
    expect(body.commodities).toBeNull();
  });

  it("returns 503 when the scan fails with nothing cached", async () => {
    runPythonModule.mockImplementation(() => Promise.reject(new Error("python missing")));
    const response = await GET(new Request("http://localhost/api/index-sentiment"));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("python missing");
  });
});
