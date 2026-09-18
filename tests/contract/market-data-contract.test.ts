import { describe, expect, it } from "vitest";
import { assessQuoteQuality } from "../../services/market-data/src/market-feed";
import { summarizeOptions } from "../../services/options-analytics/src/options-chain-service";

describe("market data contracts", () => {
  it("marks crossed quotes unsafe", () => {
    const result = assessQuoteQuality({ symbol: "NIFTY", price: 100, bid: 101, ask: 99, timestamp: new Date().toISOString(), freshness: "FRESH" });
    expect(result.freshness).toBe("STALE");
  });

  it("calculates options PCR from available open interest", () => {
    expect(summarizeOptions([{ strike: 100, ltp: 10, oi: 100, oiChange: 10 }], [{ strike: 100, ltp: 9, oi: 200, oiChange: 20 }]).pcr).toBe(2);
  });
});