import { describe, expect, it } from "vitest";
import { QuoteHub } from "../../apps/api/src/quote-hub";
import { createLtpFetcher, exchangeSymbol } from "../../adapters/groww/src/groww-ltp";
import { RateLimitError, createRateLimiter, isRateLimitError } from "../../adapters/groww/src/groww-rate-limiter";

const manualTimers = () => {
  const pending: Array<() => void> = [];
  return {
    setTimer: ((fn: () => void) => { pending.push(fn); return pending.length as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout,
    clearTimer: (() => undefined) as unknown as typeof clearTimeout,
    flush: async () => { const next = pending.splice(0); for (const fn of next) fn(); await new Promise((resolve) => setTimeout(resolve, 0)); },
  };
};

describe("Groww rate limiter", () => {
  it("never lets more than the per-second budget through", async () => {
    let clock = 0;
    const limiter = createRateLimiter(2, 100, 10_000, () => clock);
    await limiter.acquire();
    await limiter.acquire();
    let third = false;
    const pending = limiter.acquire().then(() => { third = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(third).toBe(false);
    clock = 1000;
    await pending;
    expect(third).toBe(true);
  });

  it("fails fast instead of hanging when the minute budget is spent", async () => {
    const limiter = createRateLimiter(10, 1, 5_000, () => 0);
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("recognises broker 429s as rate limits", () => {
    expect(isRateLimitError(new Error("Groww API 429: {}"))).toBe(true);
    expect(isRateLimitError(new Error("Groww API 500"))).toBe(false);
  });
});

describe("batched LTP fetcher", () => {
  it("maps index and option symbols to Groww exchange symbols", () => {
    expect(exchangeSymbol("INDIA VIX", "CASH")).toBe("NSE_INDIAVIX");
    expect(exchangeSymbol("SENSEX", "CASH")).toBe("BSE_SENSEX");
    expect(exchangeSymbol("NIFTY", "CASH")).toBe("NSE_NIFTY");
    expect(exchangeSymbol("SENSEX25O0981000CE", "FNO")).toBe("BSE_SENSEX25O0981000CE");
  });

  it("uses one request per 50 symbols", async () => {
    const paths: string[] = [];
    const fetchLtp = createLtpFetcher({ request: async (path) => {
      paths.push(path);
      const symbols = decodeURIComponent(path.split("exchange_symbols=")[1]).split(",");
      return { status: "SUCCESS", payload: Object.fromEntries(symbols.map((symbol, index) => [symbol, 100 + index])) };
    } });
    const symbols = Array.from({ length: 60 }, (_, index) => `NIFTY25O07${24000 + index * 50}CE`);
    const prices = await fetchLtp(symbols, "FNO");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("/v1/live-data/ltp?segment=FNO");
    expect(prices.size).toBe(60);
  });

  it("falls back to per-symbol quotes when the batch call is rejected", async () => {
    const paths: string[] = [];
    const fetchLtp = createLtpFetcher({ request: async (path) => {
      paths.push(path);
      if (path.includes("/ltp")) throw new Error("Groww API 400: bad request");
      return { payload: { ltp: 24900 } };
    } });
    const prices = await fetchLtp(["NIFTY"], "CASH");
    expect(prices.get("NIFTY")).toBe(24900);
    expect(paths.at(-1)).toContain("trading_symbol=NIFTY");
  });

  it("surfaces throttling instead of fanning out", async () => {
    const paths: string[] = [];
    const fetchLtp = createLtpFetcher({ request: async (path) => { paths.push(path); throw new Error("Groww API 429: too many"); } });
    await expect(fetchLtp(["NIFTY", "BANKNIFTY"], "CASH")).rejects.toThrow(/429/);
    expect(paths).toHaveLength(1);
  });
});

describe("shared quote hub", () => {
  it("polls the union of every subscription once and pushes only changes", async () => {
    const timers = manualTimers();
    const calls: Array<{ symbols: string[]; segment: string }> = [];
    let nifty = 24900;
    const hub = new QuoteHub(async (symbols, segment) => {
      calls.push({ symbols: [...symbols].sort(), segment });
      return new Map(symbols.map((symbol) => [symbol, symbol === "NIFTY" ? nifty : 50_000]));
    }, { intervalMs: 1000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const events: Array<{ cash: string[]; state: string }> = [];
    hub.subscribe((changed, status) => events.push({ cash: [...changed.cash.keys()], state: status.state }));

    hub.setSubscription("a", { cash: ["NIFTY", "BANKNIFTY"], fno: [] });
    hub.setSubscription("b", { cash: ["NIFTY"], fno: [] });
    await timers.flush();
    expect(calls).toEqual([{ symbols: ["BANKNIFTY", "NIFTY"], segment: "CASH" }]);
    expect(events.at(-1)).toEqual({ cash: ["NIFTY", "BANKNIFTY"], state: "live" });

    nifty = 24910;
    await timers.flush();
    expect(events.at(-1)).toEqual({ cash: ["NIFTY"], state: "live" });
    expect(hub.snapshot({ cash: ["NIFTY"], fno: [] }).cash[0].price).toBe(24910);
  });

  it("reports rate limiting and keeps the last prices", async () => {
    const timers = manualTimers();
    let limited = false;
    const hub = new QuoteHub(async (symbols) => {
      if (limited) throw new RateLimitError("Groww rate limit reached", 30_000);
      return new Map(symbols.map((symbol) => [symbol, 100]));
    }, { intervalMs: 1000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const states: string[] = [];
    hub.subscribe((_changed, status) => states.push(status.state));
    hub.setSubscription("a", { cash: ["NIFTY"], fno: [] });
    await timers.flush();
    limited = true;
    await timers.flush();
    expect(states).toEqual(["live", "rate-limited"]);
    expect(hub.snapshot({ cash: ["NIFTY"], fno: [] }).cash[0].price).toBe(100);
  });
});
