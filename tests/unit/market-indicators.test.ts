import { describe, expect, it } from "vitest";
import { bollingerBands, cpr, macd, pivots, rsi, supertrend } from "../../services/options-analytics/src/market-indicators";
import { detectPriceAction } from "../../services/options-analytics/src/price-action";

describe("market indicators", () => {
  const closes = Array.from({ length: 40 }, (_, index) => 100 + index + Math.sin(index));
  it("returns explicit insufficient data instead of fake zeros", () => {
    expect(rsi([100, 101], 14).status).toBe("INSUFFICIENT_DATA");
    expect(macd([100, 101], 12, 26, 9).status).toBe("INSUFFICIENT_DATA");
    expect(bollingerBands([100, 101], 20, 2).status).toBe("INSUFFICIENT_DATA");
  });
  it("calculates trend and volatility indicators", () => {
    expect(rsi(closes, 14).status).toBe("READY");
    expect(macd(closes, 12, 26, 9).status).toBe("READY");
    expect(bollingerBands(closes, 20, 2).status).toBe("READY");
    expect(supertrend(closes.map((close) => close + 2), closes.map((close) => close - 2), closes, 10, 3).status).toBe("READY");
  });
  it("calculates CPR and pivot levels", () => {
    expect(cpr(110, 100, 105).status).toBe("READY");
    expect(pivots(110, 100, 105).r1).toBe(110);
  });
  it("emits explainable price-action markers", () => {
    const markers = detectPriceAction([100, 105, 103], [95, 98, 94], [98, 104, 95]);
    expect(markers.some((marker) => marker.type === "HH_HL")).toBe(true);
    expect(markers.some((marker) => marker.type === "BREAKOUT")).toBe(true);
    expect(markers.some((marker) => marker.type === "BREAKDOWN")).toBe(true);
  });
});
