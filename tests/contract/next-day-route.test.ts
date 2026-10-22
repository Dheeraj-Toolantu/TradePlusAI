import { afterEach, describe, expect, it, vi } from "vitest";

const python = vi.hoisted(() => ({ calls: [] as Array<{ module: string; payload: Record<string, unknown> }> }));
vi.mock("../../apps/web/lib/python", () => ({
  runPythonModule: async (module: string, payload: Record<string, unknown>) => {
    python.calls.push({ module, payload });
    return { symbol: payload.symbol, status: "READY", session_date: "2026-10-21", prediction: { opening: "GAP_UP" } };
  },
}));
vi.mock("../../apps/web/lib/index-sentiment", () => ({
  getIndexSentiment: async () => ({ indices: [{ id: "NIFTY", score: -19.1, label: "BEARISH" }] }),
}));

import { GET } from "../../apps/web/app/api/algo-trading/next-day/route";

const candle = { time: "2026-10-21T09:15:00+05:30", open: 25000, high: 25010, low: 24990, close: 25005, volume: 0 };

describe("next-day setup route", () => {
  afterEach(() => { vi.unstubAllGlobals(); python.calls.length = 0; });

  it("rejects indices it does not cover", async () => {
    const response = await GET(new Request("http://localhost/api/algo-trading/next-day?symbol=RELIANCE"));
    expect(response.status).toBe(400);
  });

  it("feeds 15-minute candles, daily candles, the chain and sentiment to the next-day model", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.includes("option-chain") ? { spot: 25005, contracts: [{ strike: 25000 }] } : { candles: [candle] };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const response = await GET(new Request("http://localhost/api/algo-trading/next-day?symbol=NIFTY&refresh=1"));
    const data = await response.json();
    expect(data.setups).toHaveLength(1);
    expect(data.setups[0]).toMatchObject({ symbol: "NIFTY", status: "READY" });
    expect(urls.some((url) => url.includes("timeframe=15m") && url.includes("period=month"))).toBe(true);
    expect(urls.some((url) => url.includes("timeframe=1D"))).toBe(true);
    const call = python.calls.at(-1)!;
    expect(call.module).toBe("tradepulse_quant.algo_engine.next_day");
    expect(call.payload.index_sentiment).toEqual({ score: -19.1, label: "BEARISH" });
    expect(call.payload.option_chain).toMatchObject({ spot: 25005 });
  });

  it("reports missing candles instead of guessing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candles: [], error: "Groww historical data unavailable" }), { status: 503 })));
    const data = await (await GET(new Request("http://localhost/api/algo-trading/next-day?symbol=SENSEX&refresh=1"))).json();
    expect(data.setups[0]).toMatchObject({ symbol: "SENSEX", status: "NO_DATA" });
    expect(python.calls).toHaveLength(0);
  });
});
