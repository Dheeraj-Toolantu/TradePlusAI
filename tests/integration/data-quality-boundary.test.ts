import { describe, expect, it } from "vitest";
import { assessQuoteQuality } from "../../services/market-data/src/market-feed";
import { canEnterWithData } from "../../services/risk/src/data-quality-gate";

describe("data-quality boundary", () => {
  it("blocks crossed, invalid, and stale quotes", () => {
    expect(assessQuoteQuality({ symbol: "NIFTY", price: 100, bid: 101, ask: 99, timestamp: new Date().toISOString(), freshness: "FRESH" }).freshness).toBe("STALE");
    expect(assessQuoteQuality({ symbol: "NIFTY", price: Number.NaN, timestamp: new Date().toISOString(), freshness: "FRESH" }).freshness).toBe("STALE");
    expect(canEnterWithData("STALE")).toBe(false);
  });
  it("blocks outliers against a configured reference", () => {
    expect(assessQuoteQuality({ symbol: "NIFTY", price: 120, timestamp: new Date().toISOString(), freshness: "FRESH" }, Date.now(), 5000, 100).freshness).toBe("STALE");
  });
});
