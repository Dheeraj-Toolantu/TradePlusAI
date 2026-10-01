import { describe, expect, it } from "vitest";
import { analysePayoff, buildOptionStrategy, computeBias, intrinsicValue, normCdf, probabilityAbove, timeToExpiry, type ChainRow, type Leg } from "../../apps/web/lib/option-strategy";

// Black-Scholes-ish synthetic chain around spot so intrinsic/extrinsic are realistic.
function chain(spot: number, iv: number, days: number, step = 50, width = 12): ChainRow[] {
  const sigma = iv / 100; const t = days / 365;
  const price = (type: "CE" | "PE", strike: number) => {
    const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * t) / (sigma * Math.sqrt(t));
    const d2 = d1 - sigma * Math.sqrt(t);
    const call = spot * normCdf(d1) - strike * normCdf(d2);
    return { premium: Math.max(0.05, type === "CE" ? call : call - spot + strike), delta: type === "CE" ? normCdf(d1) : normCdf(d1) - 1 };
  };
  const atm = Math.round(spot / step) * step;
  const rows: ChainRow[] = [];
  for (let index = -width; index <= width; index += 1) {
    const strike = atm + index * step;
    for (const type of ["CE", "PE"] as const) {
      const { premium, delta } = price(type, strike);
      // Put OI heavier below spot, call OI heavier above (typical writer positioning).
      const oi = type === "PE" ? (strike < spot ? 200_000 - Math.abs(index) * 8_000 : 40_000) : strike > spot ? 180_000 - Math.abs(index) * 8_000 : 40_000;
      rows.push({ contract: type === "CE" ? "CALL" : "PUT", strike, premium: Math.round(premium * 100) / 100, iv, delta: Math.round(delta * 1000) / 1000, openInterest: Math.max(oi, 1000), lotSize: 65 });
    }
  }
  return rows;
}

const NOW = new Date("2026-10-01T05:00:00Z"); // Thursday 10:30 IST

describe("option value basics", () => {
  it("splits intrinsic value by option type", () => {
    expect(intrinsicValue("CE", 25000, 25120)).toBe(120);
    expect(intrinsicValue("PE", 25000, 25120)).toBe(0);
    expect(intrinsicValue("PE", 25200, 25120)).toBe(80);
  });

  it("computes normal CDF and lognormal tail probabilities", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(probabilityAbove(100, 100, 0.2, 0.1)).toBeLessThan(0.5);
    expect(probabilityAbove(100, 50, 0.2, 0.1)).toBeGreaterThan(0.99);
  });

  it("classifies expiry phase from the 15:30 IST settlement", () => {
    expect(timeToExpiry("2026-10-01", NOW).phase).toBe("EXPIRY_DAY");
    expect(timeToExpiry("2026-10-01", NOW).minutesToClose).toBe(300);
    expect(timeToExpiry("2026-10-02", NOW).phase).toBe("NEAR");
    expect(timeToExpiry("2026-10-06", NOW).phase).toBe("MID");
    expect(timeToExpiry("2026-10-27", NOW).phase).toBe("FAR");
  });
});

describe("payoff analysis", () => {
  const leg = (action: Leg["action"], type: Leg["type"], strike: number, premium: number): Leg => ({ action, type, strike, premium, intrinsic: 0, extrinsic: premium, delta: null });

  it("bull call spread has capped profit and loss with one breakeven", () => {
    const result = analysePayoff([leg("BUY", "CE", 25000, 150), leg("SELL", "CE", 25200, 60)], 25000, 0.13, 5 / 365);
    expect(result.maxLoss).toBe(90);
    expect(result.maxProfit).toBe(110);
    expect(result.breakevens).toEqual([25090]);
  });

  it("long call profit is unlimited and iron condor has two breakevens", () => {
    expect(analysePayoff([leg("BUY", "CE", 25000, 150)], 25000, 0.13, 5 / 365).maxProfit).toBeNull();
    const condor = analysePayoff([leg("BUY", "PE", 24600, 10), leg("SELL", "PE", 24700, 25), leg("SELL", "CE", 25300, 25), leg("BUY", "CE", 25400, 10)], 25000, 0.13, 5 / 365);
    expect(condor.maxProfit).toBe(30);
    expect(condor.maxLoss).toBe(70);
    expect(condor.breakevens).toEqual([24670, 25330]);
    expect(condor.probabilityOfProfit).toBeGreaterThan(50);
  });
});

describe("market bias", () => {
  it("combines sentiment, trend and PCR, and fades crowd extremes", () => {
    const bull = computeBias({ sentiment: { indiaScore: 50, globalScore: 20, eventRisk: [] }, trend: { regime: "TREND_UP", vwap: 24900, ema20: 25010, ema50: 24950 }, spot: 25000, pcr: 1.3 });
    expect(bull.label).toBe("STRONGLY_BULLISH");
    const bear = computeBias({ sentiment: { indiaScore: -40, globalScore: -20, eventRisk: [] }, trend: { regime: "TREND_DOWN", vwap: 25100, ema20: 24900, ema50: 25000 }, spot: 25000, pcr: 0.7 });
    expect(bear.score).toBeLessThan(-45);
    const crowd = computeBias({ sentiment: { indiaScore: 90, globalScore: null, eventRisk: [] }, spot: 25000, pcr: null });
    expect(crowd.sentiment).toBeCloseTo(90 * 0.35 * 0.5, 2);
  });
});

describe("strategy selection", () => {
  it("picks a directional bullish structure on strong bullish bias with cheap volatility", () => {
    const result = buildOptionStrategy({ symbol: "NIFTY", spot: 25010, expiry: "2026-10-13", chain: chain(25010, 11, 12), vix: 11, sentiment: { indiaScore: 55, globalScore: 30, eventRisk: [] }, trend: { regime: "TREND_UP", vwap: 24950, ema20: 25000, ema50: 24900 }, now: NOW });
    expect(result.factors.phase).toBe("FAR");
    expect(result.factors.ivRegime).toBe("LOW");
    expect(["LONG_CALL", "BULL_CALL_SPREAD"]).toContain(result.primary?.id);
    expect(result.verdict).toBe("TRADE");
    expect(result.primary?.legs.every((l) => l.premium > 0)).toBe(true);
  });

  it("sells defined-risk premium when neutral, volatility is high and expiry is near", () => {
    const result = buildOptionStrategy({ symbol: "NIFTY", spot: 25000, expiry: "2026-10-02", chain: chain(25000, 19, 1.2), vix: 19, sentiment: { indiaScore: 2, globalScore: -3, eventRisk: [] }, trend: { regime: "RANGE", vwap: 25010, ema20: 25000, ema50: 24990 }, now: NOW });
    expect(result.factors.phase).toBe("NEAR");
    expect(["IRON_CONDOR", "IRON_BUTTERFLY"]).toContain(result.primary?.id);
    expect(result.primary?.kind).toBe("CREDIT");
    expect(result.primary?.maxLoss).toBeGreaterThan(0); // wings make the risk finite
  });

  it("prefers long volatility before an event and penalises short premium", () => {
    const result = buildOptionStrategy({ symbol: "BANKNIFTY", spot: 55000, expiry: "2026-10-27", chain: chain(55000, 11, 26, 100), vix: 11, sentiment: { indiaScore: 0, globalScore: 0, eventRisk: ["RBI policy"] }, trend: null, now: NOW });
    expect(["LONG_STRADDLE", "LONG_STRANGLE"]).toContain(result.primary?.id);
    expect(result.notes.some((note) => note.includes("RBI policy"))).toBe(true);
  });

  it("decomposes premiums and buys in the money near expiry to cut time value", () => {
    const result = buildOptionStrategy({ symbol: "SENSEX", spot: 82000, expiry: "2026-10-02", chain: chain(82000, 12, 1.2, 100), vix: 11.5, sentiment: { indiaScore: 60, globalScore: 40, eventRisk: [] }, trend: { regime: "TREND_UP", vwap: 81800, ema20: 81950, ema50: 81700 }, now: NOW });
    const call = [result.primary, ...result.alternatives].find((plan) => plan?.id === "LONG_CALL");
    expect(call?.legs[0].strike).toBeLessThan(82000);
    expect(call?.legs[0].intrinsic).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.intrinsic + row.extrinsic).toBeCloseTo(Math.max(row.premium, row.intrinsic), 1);
  });

  it("waits when the chain is missing and in the final hour of expiry", () => {
    expect(buildOptionStrategy({ symbol: "NIFTY", spot: 25000, expiry: "2026-10-02", chain: [], now: NOW }).verdict).toBe("WAIT");
    const late = buildOptionStrategy({ symbol: "NIFTY", spot: 25000, expiry: "2026-10-01", chain: chain(25000, 14, 0.05), vix: 14, now: new Date("2026-10-01T09:20:00Z") });
    expect(late.verdict).toBe("WAIT");
    expect(late.headline).toMatch(/Final hour/);
  });
});
