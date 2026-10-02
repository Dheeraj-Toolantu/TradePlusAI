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

describe("indicator correctness", () => {
  it("RSI reflects the latest data, not the oldest 14 changes", () => {
    const upThenDown = [...Array.from({ length: 20 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 119 - i * 2)];
    const value = rsi(upThenDown, 14);
    expect(value.status === "READY" && value.value).toBeLessThan(30);
  });
  it("MACD signal is an EMA of the MACD line (near the line in a steady trend)", () => {
    const steady = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const value = macd(steady, 12, 26, 9);
    expect(value.status).toBe("READY");
    if (value.status === "READY") expect(Math.abs(value.value.histogram)).toBeLessThan(0.05);
  });
  it("Supertrend flips DOWN after a sustained decline", () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 129 - i * 2)];
    const value = supertrend(closes.map((close) => close + 1), closes.map((close) => close - 1), closes, 10, 3);
    expect(value.status === "READY" && value.value.direction).toBe("DOWN");
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    const up = supertrend(rising.map((close) => close + 1), rising.map((close) => close - 1), rising, 10, 3);
    expect(up.status === "READY" && up.value.direction).toBe("UP");
    if (up.status === "READY") expect(up.value.value).toBeLessThan(rising.at(-1)!);
  });
});
