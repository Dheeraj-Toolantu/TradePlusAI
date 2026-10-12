import { beforeEach, describe, expect, it, vi } from "vitest";

const runPythonModule = vi.fn();
vi.mock("../../apps/web/lib/python", () => ({ runPythonModule: (...args: unknown[]) => runPythonModule(...args) }));

import { GET } from "../../apps/web/app/api/index-sentiment/route";

const scan = (score: number) => ({ generated_at: new Date().toISOString(), indices: [{ id: "NIFTY", score, constituents: [] }], market_context: null, sources: [], method: "" });
const store = globalThis as { __tradepulseIndexSentiment?: { at: number } | null; __tradepulseSentiment?: unknown };

describe("index sentiment route", () => {
  beforeEach(() => {
    store.__tradepulseIndexSentiment = null;
    store.__tradepulseSentiment = { at: Date.now(), value: { composite: { overall: { score: -30 }, india: { score: -20 }, global: { score: -40 }, retail: { score: 10 } } } };
    runPythonModule.mockReset();
  });

  it("passes the cached macro backdrop to the engine and caches the scan", async () => {
    runPythonModule.mockResolvedValueOnce(scan(22)).mockResolvedValueOnce(scan(-5));
    const first = await (await GET(new Request("http://localhost/api/index-sentiment"))).json();
    expect(first.indices[0].score).toBe(22);
    expect(runPythonModule).toHaveBeenCalledWith("tradepulse_quant.sentiment.index_engine", { market_context: { overall_score: -30, india_score: -20, global_score: -40, retail_score: 10 } }, 90_000);
    // Within the minimum interval a manual refresh serves the cache.
    expect((await (await GET(new Request("http://localhost/api/index-sentiment?refresh=1"))).json()).indices[0].score).toBe(22);
    store.__tradepulseIndexSentiment!.at -= 3 * 60_000;
    expect((await (await GET(new Request("http://localhost/api/index-sentiment?refresh=1"))).json()).indices[0].score).toBe(-5);
    expect(runPythonModule).toHaveBeenCalledTimes(2);
  });

  it("returns 503 when the scan fails with nothing cached", async () => {
    runPythonModule.mockRejectedValueOnce(new Error("python missing"));
    const response = await GET(new Request("http://localhost/api/index-sentiment"));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("python missing");
  });
});
