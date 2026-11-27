import { describe, expect, it } from "vitest";
import { DEFAULT_MONEY_TRAIL, moneyStopPnl, moneyTrailError, moneyTrailPrices } from "../../services/paper-trading/src/scalper-trail";

describe("money (₹ P&L) stop and trail", () => {
  const config = { ...DEFAULT_MONEY_TRAIL, target: 1500 };
  it("holds −₹500 until +₹500, then −₹200, then +₹200 per further ₹200", () => {
    expect(moneyStopPnl(0, config)).toBe(-500);
    expect(moneyStopPnl(499, config)).toBe(-500);
    expect(moneyStopPnl(500, config)).toBe(-200);
    expect(moneyStopPnl(699, config)).toBe(-200);
    expect(moneyStopPnl(700, config)).toBe(0);
    expect(moneyStopPnl(900, config)).toBe(200);
    expect(moneyStopPnl(1300, config)).toBe(600);
  });
  it("turns rupees into premium prices (stop and target rounded up to the tick)", () => {
    // 65 qty bought at ₹100: −₹500 → 100 − 7.69 = 92.31 → 92.35; target +₹1500 → 123.08 → 123.10.
    expect(moneyTrailPrices({ entry: 100, quantity: 65, bestPnl: 0, config })).toMatchObject({ stopPnl: -500, stop: 92.35, target: 123.1, trailing: false });
    expect(moneyTrailPrices({ entry: 100, quantity: 65, bestPnl: 910, config })).toMatchObject({ stopPnl: 200, stop: 103.1, trailing: true });
  });
  it("validates the settings", () => {
    expect(moneyTrailError(DEFAULT_MONEY_TRAIL)).toBeNull();
    expect(moneyTrailError({ ...DEFAULT_MONEY_TRAIL, firstStop: -600 })).toMatch(/first trailed stop/);
    expect(moneyTrailError({ ...DEFAULT_MONEY_TRAIL, target: 300 })).toMatch(/Target/);
    expect(moneyTrailError({ ...DEFAULT_MONEY_TRAIL, step: 0 })).toMatch(/step/);
  });
});

import { SmartScalper, valueOption, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";

const at = (ist: string, day = "2026-11-02") => () => new Date(`${day}T${ist}:00+05:30`);
const contract: ScalperContract = { symbol: "NIFTY26N1024800CE", contract: "CALL", expiry: "2026-11-10", strike: 24800, premium: 100, bid: 100, ask: 100, openInterest: 500000, volume: 900000, iv: 13.5, delta: 0.576, theta: -9, lotSize: 65, tickSize: 0.05 };
const plan = (): ScalperPlan => ({
  kind: "SCALP", side: "CE", legs: [{ symbol: contract.symbol, contract: "CALL", strike: 24800, side: "BUY", price: 100, valuation: valueOption(contract, 24819) }],
  lots: 1, quantity: 65, entry: 100, stop: 93, target: 115, riskPerLot: 455, rewardPerLot: 975, riskReward: 2.1,
  spot: { entry: 24819, stop: 24700, target: 24900 }, reason: "test",
});
const tick = (book: SmartScalper, premium: number) => book.manage({ symbol: "NIFTY", spot: 24825, bars: [], contracts: [{ ...contract, premium, bid: premium, ask: premium }] });
const MONEY = { moneyTrail: { enabled: true, stopLoss: 500, trigger: 500, firstStop: -200, step: 200, target: 1500 } };

describe("Smart Scalper: money (₹ P&L) stop and trail", () => {
  it("starts new trades at −₹500 and the ₹ target when switched on in the settings", async () => {
    const book = new SmartScalper({ now: at("10:05"), hydrate: false });
    const placed = await book.place("NIFTY", plan(), [contract], { setupId: "m1", settings: MONEY });
    expect(placed.position).toMatchObject({ stop: 92.35, target: 123.1, controls: { mode: "MONEY" } });
    const out = await tick(book, 92.3); // −₹500.5
    expect(out.exited[0]).toMatchObject({ exitReason: "MONEY_STOP_LOSS" });
    expect(out.exited[0].realizedPnl).toBeGreaterThanOrEqual(-503.25);
  });

  it("trails: −₹200 at +₹500, then +₹200 per ₹200, exits on the trail or at the ₹ target", async () => {
    const book = new SmartScalper({ now: at("10:05"), hydrate: false });
    await book.place("NIFTY", plan(), [contract], { setupId: "m2", settings: MONEY });
    let out = await tick(book, 107.7); // +₹500.5
    expect(out.positions[0].stop).toBe(96.95); // −₹200 → 96.92 → 96.95
    out = await tick(book, 111); // +₹715 → stop at ₹0
    expect(out.positions[0].stop).toBe(100);
    out = await tick(book, 114.2); // +₹923 → stop +₹200
    expect(out.positions[0].stop).toBe(103.1);
    out = await tick(book, 103);
    expect(out.exited[0]).toMatchObject({ exitReason: "MONEY_TRAIL_STOP" });
    expect(out.exited[0].realizedPnl).toBeGreaterThan(0);
    const other = new SmartScalper({ now: at("10:05"), hydrate: false });
    await other.place("NIFTY", plan(), [contract], { setupId: "m3", settings: MONEY });
    out = await tick(other, 124);
    expect(out.exited[0]).toMatchObject({ exitReason: "MONEY_TARGET" });
  });

  it("switches an open trade to the money rule with Modify", async () => {
    const book = new SmartScalper({ now: at("10:05"), hydrate: false });
    const placed = await book.place("NIFTY", plan(), [contract], { setupId: "m4" });
    const id = placed.positions[0].id;
    await tick(book, 101);
    expect((await book.modify("NIFTY", id, { trailMode: "MONEY", money: { stopLoss: 500, trigger: 500, firstStop: -600, step: 200, target: 0 } })).error).toMatch(/first trailed stop/);
    const result = await book.modify("NIFTY", id, { trailMode: "MONEY", money: { stopLoss: 300, trigger: 400, firstStop: 0, step: 100, target: 0 } });
    expect(result).toMatchObject({ modified: true, position: { stop: 95.4, controls: { mode: "MONEY" } } }); // −₹300 → 95.38 → 95.40
  });
});
