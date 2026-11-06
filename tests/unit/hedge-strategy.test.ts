import { describe, expect, it } from "vitest";
import { breakevensOf, bsPrice, buildHedgeStrategies, payoffAt, pnlNow, profitProbability, type HedgeLeg } from "../../apps/web/lib/hedge-strategy";
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
const leg = (type: "CE" | "PE", strike: number, lots: number, premium: number): HedgeLeg => ({ type, strike, lots, premium, delta: null, theta: null, iv: 13, openInterest: 1, oiShare: 1 });

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

describe("your target, the horizon and the OI data", () => {
  const base = { symbol: "NIFTY", spot: 25_010, expiry: EXPIRY, chain: chain(25_010, 13, 4), now: NOW };

  it("values a 100-point move now (repriced) and at expiry, with ±100 in the scenarios", () => {
    const result = buildHedgeStrategies({ ...base, targetPoints: 100, direction: "UP", horizon: "NOW" });
    const plan = result.primary!;
    expect(result.targetPoints).toBe(100);
    const up = plan.scenarios.find((row) => row.move === 100)!; const down = plan.scenarios.find((row) => row.move === -100)!;
    expect(plan.rewardUp).toBeCloseTo(up.now, 1);
    expect(plan.rewardDown).toBeCloseTo(down.now, 1);
    expect(plan.scenarios.find((row) => row.move === 0)!.now).toBe(0);
    expect(up.expiry).toBeCloseTo(payoffAt(plan.legs, 25_110) * 65, 1);
    const atExpiry = buildHedgeStrategies({ ...base, targetPoints: 100, direction: "UP", horizon: "EXPIRY" });
    expect(atExpiry.notes.join(" ")).toContain("smaller than");
  });

  it("repricing now follows Black-Scholes and an up-move helps a call-heavy hedge", () => {
    expect(bsPrice("CE", 25_000, 25_000, 0, 0.13)).toBe(0);
    expect(bsPrice("CE", 25_000, 25_000, 4 / 365, 0.13) - bsPrice("PE", 25_000, 25_000, 4 / 365, 0.13)).toBeCloseTo(0, 6); // put-call parity at the money
    const strap = [leg("CE", 25_000, 2, 0), leg("PE", 25_000, 1, 0)];
    expect(pnlNow(strap, 25_000, 25_100, 4 / 365, 0.13)).toBeGreaterThan(0);
  });

  it("a chosen direction overrides the bias", () => {
    expect(buildHedgeStrategies({ ...base, targetPoints: 150, direction: "DOWN" }).side).toBe("DOWN");
    const down = buildHedgeStrategies({ ...base, targetPoints: 150, direction: "DOWN" }).primary!;
    expect(down.legs[1].lots).toBeGreaterThanOrEqual(down.legs[0].lots);
  });

  it("skips illiquid strikes, ranks strikes past an OI wall lower and flags a target through a wall", () => {
    const rows = chain(25_010, 13, 4).map((row) => ({
      ...row,
      // A call wall at 25 100 and a put wall at 24 900; 25 150 CE nearly untraded.
      openInterest: row.contract === "CALL" ? (row.strike === 25_100 ? 900_000 : row.strike === 25_150 ? 5_000 : 200_000) : row.strike === 24_900 ? 800_000 : 200_000,
    }));
    const result = buildHedgeStrategies({ ...base, chain: rows, targetPoints: 200, direction: "UP", horizon: "NOW" });
    expect(result.walls).toMatchObject({ call: 25_100, put: 24_900 });
    for (const plan of [result.primary!, ...result.alternatives]) expect(plan.legs.some((item) => item.strike === 25_150 && item.type === "CE")).toBe(false);
    expect(result.notes.join(" ")).toContain("25100 call wall");
    expect(result.primary!.oi.minShare).toBeGreaterThanOrEqual(0.1);
  });
});
