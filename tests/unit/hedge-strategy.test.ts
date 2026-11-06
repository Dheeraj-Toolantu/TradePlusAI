import { describe, expect, it } from "vitest";
import { breakevensOf, buildHedgeStrategies, payoffAt, profitProbability, type HedgeLeg } from "../../apps/web/lib/hedge-strategy";
import { normCdf, type ChainRow } from "../../apps/web/lib/option-strategy";

function chain(spot: number, iv: number, days: number, step = 50, width = 10): ChainRow[] {
  const sigma = iv / 100; const t = days / 365;
  const atm = Math.round(spot / step) * step;
  const rows: ChainRow[] = [];
  for (let index = -width; index <= width; index += 1) {
    const strike = atm + index * step;
    const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * t) / (sigma * Math.sqrt(t));
    const call = spot * normCdf(d1) - strike * normCdf(d1 - sigma * Math.sqrt(t));
    rows.push({ contract: "CALL", strike, premium: Math.round(call * 100) / 100, iv, delta: Math.round(normCdf(d1) * 1000) / 1000, theta: -8, openInterest: 100_000, lotSize: 65 });
    rows.push({ contract: "PUT", strike, premium: Math.round((call - spot + strike) * 100) / 100, iv, delta: Math.round((normCdf(d1) - 1) * 1000) / 1000, theta: -8, openInterest: 100_000, lotSize: 65 });
  }
  return rows;
}
const NOW = new Date("2026-11-06T05:00:00Z"); // Friday 10:30 IST
const EXPIRY = "2026-11-10";
const leg = (type: "CE" | "PE", strike: number, lots: number, premium: number): HedgeLeg => ({ type, strike, lots, premium, delta: null, theta: null, openInterest: 1 });

describe("hedge payoff maths (option buys only)", () => {
  it("loses at most the premium paid and has two breakevens for a straddle", () => {
    const legs = [leg("CE", 25_000, 1, 120), leg("PE", 25_000, 1, 110)];
    expect(payoffAt(legs, 25_000)).toBe(-230); // pinned at the strike: the whole premium
    expect(payoffAt(legs, 25_400)).toBe(170);
    expect(breakevensOf(legs, 25_000)).toEqual([24_770, 25_230].map((value) => expect.closeTo(value, 0)));
  });

  it("a 2:1 strap pays twice as fast on the upside", () => {
    const legs = [leg("CE", 25_000, 2, 120), leg("PE", 25_000, 1, 110)];
    expect(payoffAt(legs, 25_300) - payoffAt(legs, 25_200)).toBe(200);
    expect(payoffAt(legs, 24_700) - payoffAt(legs, 24_800)).toBe(100);
  });

  it("profit probability is between 0 and 1 and grows with volatility", () => {
    const legs = [leg("CE", 25_000, 1, 120), leg("PE", 25_000, 1, 110)];
    const be = breakevensOf(legs, 25_000);
    const low = profitProbability(legs, 25_000, be, 0.10, 4 / 365);
    const high = profitProbability(legs, 25_000, be, 0.25, 4 / 365);
    expect(low).toBeGreaterThan(0); expect(high).toBeLessThan(1); expect(high).toBeGreaterThan(low);
  });
});

describe("hedge builder ranks buy-only combinations", () => {
  it("neutral market: picks a two-way hedge, max loss = premium, ranked by reward : risk", () => {
    const result = buildHedgeStrategies({ symbol: "NIFTY", spot: 25_010, expiry: EXPIRY, chain: chain(25_010, 13, 4), now: NOW });
    expect(result.side).toBe("BOTH");
    const plan = result.primary!;
    expect(plan.legs.every((item) => item.lots >= 1)).toBe(true);
    expect(plan.maxLoss).toBe(plan.debit);
    expect(plan.debit).toBeCloseTo(plan.legs.reduce((sum, item) => sum + item.lots * item.premium, 0) * 65, 1);
    expect(Math.min(...plan.payoff.map((point) => point.pnl))).toBeGreaterThanOrEqual(-plan.debit - 0.01);
    for (const other of result.alternatives) expect(other.riskReward).toBeLessThanOrEqual(plan.riskReward + 0.05);
    expect(new Set([plan.id, ...result.alternatives.map((item) => item.id)]).size).toBe(1 + result.alternatives.length);
    expect(plan.rationale[0]).toContain("Only buys options");
  });

  it("bullish trend: favours the upside and keeps a real hedge on the downside", () => {
    const result = buildHedgeStrategies({ symbol: "NIFTY", spot: 25_010, expiry: EXPIRY, chain: chain(25_010, 13, 4), trend: { regime: "BULLISH", vwap: 24_950, ema20: 25_000, ema50: 24_900 }, now: NOW });
    expect(result.side).toBe("UP");
    const plan = result.primary!;
    expect(plan.legs[0].lots).toBeGreaterThanOrEqual(plan.legs[1].lots);
    expect(plan.rewardUp).toBeGreaterThan(plan.rewardDown);
    expect(plan.hedgeCover).toBeGreaterThanOrEqual(0.4);
  });

  it("respects the risk budget", () => {
    const result = buildHedgeStrategies({ symbol: "NIFTY", spot: 25_010, expiry: EXPIRY, chain: chain(25_010, 13, 4), maxRisk: 12_000, now: NOW });
    for (const plan of [result.primary!, ...result.alternatives]) expect(plan.debit).toBeLessThanOrEqual(12_000);
    const tiny = buildHedgeStrategies({ symbol: "NIFTY", spot: 25_010, expiry: EXPIRY, chain: chain(25_010, 13, 4), maxRisk: 100, now: NOW });
    expect(tiny.notes.join(" ")).toContain("No hedge fits");
  });
});
