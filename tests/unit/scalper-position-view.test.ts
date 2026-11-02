import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SmartScalper, valueOption, type PositionView, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";
import { VWAP_EMA_TRAIL, nextTrailStep } from "../../services/paper-trading/src/scalper-trail";
import { PositionCard } from "../../apps/web/components/scalper/position-card";

const at = (ist: string) => () => new Date(`2026-11-02T${ist}:00+05:30`);
const contract: ScalperContract = {
  symbol: "NIFTY26N1024800CE", contract: "CALL", expiry: "2026-11-10", strike: 24800, premium: 120.45, bid: 120.05, ask: 120.85,
  openInterest: 500000, volume: 900000, iv: 13.5, delta: 0.576, theta: -9, lotSize: 65, tickSize: 0.05,
};
const signal = { adx: 24.3, plusDi: 28.1, minusDi: 13.9, rising: true, triggerTime: "2026-11-02T09:42:00+05:30" };
const plan = (overrides: Partial<ScalperPlan> = {}): ScalperPlan => ({
  kind: "SCALP", side: "CE",
  legs: [{ symbol: contract.symbol, contract: "CALL", strike: 24800, side: "BUY", price: 120.85, valuation: valueOption(contract, 24819) }],
  lots: 1, quantity: 65, entry: 120.85, stop: 114.1, target: 133.95, riskPerLot: 438.75, rewardPerLot: 851.5, riskReward: 1.94,
  spot: { entry: 24819, stop: 24807.61, target: 24841.79 }, reason: "VWAP-EMA scalper 1:2: long NIFTY, ADX 24.3",
  trail: { rule: "VWAP_EMA", costPerUnit: 0.6 }, signal, ...overrides,
});

describe("VWAP-EMA scalper position: entry signal and excursions", () => {
  it("keeps the ADX that confirmed the entry, tracks the worst premium, and restores both after a restart", async () => {
    const scalper = new SmartScalper({ now: at("10:05") });
    const placed = await scalper.place("NIFTY", plan(), [contract], { setupId: "VWAP_EMA_SCALP:NIFTY:CE:09:42" });
    expect(placed.placed).toBe(true);
    expect(placed.positions[0].signal).toEqual(signal);
    expect(placed.positions[0].lowWater).toBe(placed.positions[0].entry);

    const dip = await scalper.manage({ symbol: "NIFTY", spot: 24815, bars: [], contracts: [{ ...contract, premium: 117.2 }] });
    expect(dip.positions[0].lowWater).toBe(117.2);
    const rally = await scalper.manage({ symbol: "NIFTY", spot: 24830, bars: [], contracts: [{ ...contract, premium: 126 }] });
    expect(rally.positions[0]).toMatchObject({ lowWater: 117.2, highWater: 126 });

    await new Promise((resolve) => setTimeout(resolve, 0)); // persist() writes fire-and-forget; a real restart comes much later
    const restarted = new SmartScalper({ now: at("10:07") });
    await restarted.openBook(); // hydrates from Firestore
    const restored = restarted.state("NIFTY").positions[0];
    expect(restored.signal).toEqual(signal);
    expect(restored.lowWater).toBe(117.2);
    expect(restored.trail?.stage).toBe(rally.positions[0].trail?.stage);
  });
});

describe("next trail step", () => {
  const base = { entry: 120, risk: 8, costPerUnit: 0.6, highWater: 121 };
  it("names the premium that moves the stop and where it goes", () => {
    expect(nextTrailStep({ ...base, stage: "INITIAL" })).toEqual({ trigger: 120 + 8 * VWAP_EMA_TRAIL.breakevenAt, stopTo: 120.6, label: "breakeven + charges" });
    expect(nextTrailStep({ ...base, stage: "BREAKEVEN" })).toEqual({ trigger: 128, stopTo: 124, label: "lock +0.5R" });
    expect(nextTrailStep({ ...base, stage: "TRAILING", highWater: 132 })).toMatchObject({ trigger: null, stopTo: 127.2 });
    expect(nextTrailStep({ ...base, risk: 0, stage: "INITIAL" })).toBeNull();
  });
});

describe("position card", () => {
  const view = (overrides: Partial<PositionView> = {}): PositionView => ({
    id: "p1", kind: "SCALP", side: "CE", underlying: "NIFTY", openedAt: "2026-11-02T10:05:00+05:30", entry: 121.25, stop: 125.25, target: 136.35,
    initialRisk: 7.55, highWater: 131.6, lowWater: 119.4, trailing: true, spot: { entry: 24819, stop: 24807.6, target: 24846.5 }, reason: "", status: "OPEN",
    trail: { rule: "VWAP_EMA", risk: 7.55, costPerUnit: 0.6, stage: "LOCKED" }, signal,
    legs: [{ symbol: contract.symbol, contract: "CALL", strike: 24800, expiry: "2026-11-10", side: "BUY", quantity: 65, entry: 121.25, ltp: 129.8, orderId: "o1" }],
    quantity: 65, value: 129.8, pnl: (129.8 - 121.25) * 65, label: contract.symbol, ...overrides,
  });

  it("shows live P&L in rupees, percent and R, the trailing stop and what it locks, and the ADX at entry", () => {
    const html = renderToStaticMarkup(createElement(PositionCard, { position: view(), now: Date.parse("2026-11-02T10:09:30+05:30"), spot: 24838.2, maxHoldMinutes: 12 }));
    expect(html).toContain("+₹555.75"); // (129.80 − 121.25) × 65
    expect(html).toContain("+7.05%");
    expect(html).toContain("+1.13R"); // 8.55 / 7.55
    expect(html).toContain("+0.5R locked");
    expect(html).toContain("Trailing SL");
    expect(html).toContain("Locked if SL hits");
    expect(html).toContain("+₹260.00"); // (125.25 − 121.25) × 65 kept if the stop is hit
    expect(html).toContain("4:30"); // time in trade
    expect(html).not.toContain("time stop"); // +0.5R reached, so no time stop
    expect(html).toContain("ADX(14) <b class=\"gain\">24.3</b>");
    expect(html).toContain("Best (MFE)");
    expect(html).toContain("now 24,838.2");
  });

  it("counts down the time stop before +0.5R and shows a closed trade's exit reason", () => {
    const early = view({ highWater: 122, stop: 113.7, trailing: false, trail: { rule: "VWAP_EMA", risk: 7.55, costPerUnit: 0.6, stage: "INITIAL" }, value: 120.5, pnl: (120.5 - 121.25) * 65 });
    const live = renderToStaticMarkup(createElement(PositionCard, { position: early, now: Date.parse("2026-11-02T10:14:00+05:30"), maxHoldMinutes: 12 }));
    expect(live).toContain("time stop 3:00");
    expect(live).toContain("Loss if SL hits");
    expect(live).toContain("at ₹125.03 the SL moves to <b>₹121.85</b>");
    const closed = renderToStaticMarkup(createElement(PositionCard, { position: view({ status: "EXITED", exitReason: "TRAILING_STOP", exitValue: 127.4, realizedPnl: 399.75, exitAt: "2026-11-02T10:21:10+05:30" }), closed: true, now: 0, maxHoldMinutes: 12 }));
    expect(closed).toContain("Trailing stop");
    expect(closed).toContain("+₹399.75");
    expect(closed).toContain("16:10");
    expect(closed).not.toContain("pos-exit");
  });
});
