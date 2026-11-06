import { afterEach, describe, expect, it, vi } from "vitest";
import { createGrowwTransport, marketDataTtl, marketOpenIst } from "../../adapters/groww/src/groww-adapter";

const MARKET_HOURS = Date.parse("2026-11-06T11:00:00+05:30");
const PRE_MARKET = Date.parse("2026-11-06T07:27:00+05:30");

describe("Groww market data under a rate limit", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

  it("answers a 429 with the last good body instead of failing", async () => {
    vi.useFakeTimers({ now: MARKET_HOURS, toFake: ["Date"] });
    let status = 200;
    globalThis.fetch = (async () => new Response(status === 200 ? JSON.stringify({ payload: { ltp: 24_812 } }) : "{}", { status, headers: { "content-type": "application/json" } })) as typeof fetch;
    const transport = createGrowwTransport({ GROWW_ACCESS_TOKEN: "token", GROWW_API_BASE_URL: "https://fallback.test" });
    const path = "/v1/live-data/quote?exchange=NSE&segment=CASH&trading_symbol=FALLBACKTEST";
    expect(await transport.request(path, { method: "GET", cacheTtlMs: 1 })).toEqual({ payload: { ltp: 24_812 } });
    vi.setSystemTime(MARKET_HOURS + 10_000);
    status = 429;
    expect(await transport.request(path, { method: "GET", cacheTtlMs: 1 })).toEqual({ payload: { ltp: 24_812 } });
    // During the cooldown the same stale body keeps answering, with no new call.
    expect(await transport.request(path, { method: "GET", cacheTtlMs: 1 })).toEqual({ payload: { ltp: 24_812 } });
  });

  it("keeps a 5-minute cache while the market is shut and longer caches for candles and chains", () => {
    expect(marketOpenIst(PRE_MARKET)).toBe(false);
    expect(marketOpenIst(MARKET_HOURS)).toBe(true);
    expect(marketDataTtl("/v1/live-data/ltp?x", 1_000, PRE_MARKET)).toBe(300_000);
    expect(marketDataTtl("/v1/live-data/ltp?x", 1_000, MARKET_HOURS)).toBe(1_000);
    expect(marketDataTtl("/v1/historical/candle/range?x", undefined, MARKET_HOURS)).toBe(20_000);
    expect(marketDataTtl("/v1/option-chain/exchange/NSE", undefined, MARKET_HOURS)).toBe(10_000);
    expect(marketDataTtl("/v1/order/status/x", undefined, PRE_MARKET)).toBe(5_000);
  });
});
