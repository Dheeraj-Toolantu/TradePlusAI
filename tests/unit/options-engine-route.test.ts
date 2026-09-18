import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../apps/web/app/api/options-engine/route";

describe("options-engine fail-closed behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns an explicit NO_TRADE / WAIT decision when Groww has no actionable chain data", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/api/market-data?provider=groww&symbols=NIFTY")) {
        return Response.json({ quotes: [{ symbol: "NIFTY", price: 23300 }] });
      }

      if (url.includes("/api/market-data/history")) {
        return Response.json({
          candles: [
            { time: 1, open: 23300, high: 23305, low: 23295, close: 23302, volume: 2000 },
            { time: 2, open: 23302, high: 23308, low: 23298, close: 23306, volume: 2200 },
          ],
        });
      }

      if (url.includes("/v1/option-chain/exchange/NSE/underlying/NIFTY")) {
        return Response.json({ status: "SUCCESS", payload: { underlying_ltp: 23300, strikes: {} } });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const response = await GET(new Request("http://localhost/api/options-engine?provider=groww&symbols=NIFTY"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      blocked: true,
      candidates: [],
      decision: "NO_TRADE",
      status: "WAIT",
      message: expect.stringContaining("No trade recommendation generated"),
    });
  });
});
