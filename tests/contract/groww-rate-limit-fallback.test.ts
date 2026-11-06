import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

  it("shares one access token between processes through the token file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tp-token-"));
    const file = path.join(dir, "token.json");
    const base = "https://shared-token.test";
    const valid = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
    // Another process already generated a token for this key.
    writeFileSync(file, JSON.stringify({ key: createHash("sha256").update(`${base}:key-a`).digest("hex"), token: valid }));
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { calls.push(`${String(input)} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`); return new Response(JSON.stringify({ payload: { ltp: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    const transport = createGrowwTransport({ GROWW_API_KEY: "key-a", GROWW_API_SECRET: "secret", GROWW_API_BASE_URL: base, GROWW_TOKEN_CACHE_FILE: file });
    await transport.request("/v1/user/profile", { method: "GET" });
    expect(calls.some((call) => call.includes("token/api/access"))).toBe(false);
    expect(calls[0]).toContain(`Bearer ${valid}`);

    // A fresh key generates once and writes the token for the others, owner-only.
    const other = path.join(dir, "other.json");
    globalThis.fetch = (async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("token/api/access") ? { payload: { token: valid } } : { payload: {} }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    await createGrowwTransport({ GROWW_API_KEY: "key-b", GROWW_API_SECRET: "secret", GROWW_API_BASE_URL: base, GROWW_TOKEN_CACHE_FILE: other }).request("/v1/portfolio/positions", { method: "GET" });
    expect(JSON.parse(readFileSync(other, "utf8")).token).toBe(valid);
    if (process.platform !== "win32") expect(statSync(other).mode & 0o077).toBe(0);
  });
});
