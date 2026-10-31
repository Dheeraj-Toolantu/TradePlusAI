import { afterEach, describe, expect, it } from "vitest";
import { SmartScalper, valueOption, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";
import { scalperMonitorTick, stopScalperMonitor, type MonitorDeps } from "../../apps/web/lib/scalper-monitor";

const contract: ScalperContract = { symbol: "NIFTY26N1024800CE", contract: "CALL", expiry: "2026-11-10", strike: 24800, premium: 120.85, bid: 120.45, ask: 120.85, openInterest: 500000, volume: 900000, iv: 13.5, delta: 0.576, theta: -9, lotSize: 65, tickSize: 0.05 };
const plan: ScalperPlan = {
  kind: "SCALP", side: "CE", legs: [{ symbol: contract.symbol, contract: "CALL", strike: 24800, side: "BUY", price: 120.85, valuation: valueOption(contract, 24819) }],
  lots: 1, quantity: 65, entry: 120.85, stop: 114.1, target: 133.95, riskPerLot: 438.75, rewardPerLot: 851.5, riskReward: 1.94,
  spot: { entry: 24819, stop: 24807.61, target: 24841.79 }, reason: "VWAP-EMA scalper 1:2", trail: { rule: "VWAP_EMA", costPerUnit: 2.15 },
};
const holder = globalThis as typeof globalThis & { __tradepulseScalper?: SmartScalper };

async function bookWithOpenScalp(clock: { now: Date }) {
  const scalper = new SmartScalper({ now: () => clock.now, hydrate: false });
  holder.__tradepulseScalper = scalper;
  await scalper.place("NIFTY", plan, [contract], { setupId: "monitor" });
  return scalper;
}
const deps = (premium: number | null, spot: number | null = 24825): MonitorDeps => ({ optionQuote: async () => premium, spot: async () => spot, bars: async () => [], now: () => Date.now() });

describe("server-side scalper exit monitor (defect 5)", () => {
  afterEach(() => { stopScalperMonitor(); delete holder.__tradepulseScalper; });

  it("takes the target with no browser scan at all", async () => {
    const clock = { now: new Date("2026-11-02T10:05:00+05:30") };
    const scalper = await bookWithOpenScalp(clock);
    const result = await scalperMonitorTick(deps(134.1));
    expect(result).toMatchObject({ skipped: false, underlyings: 1, exits: 1 });
    expect((await scalper.snapshot("NIFTY")).closed[0]).toMatchObject({ exitReason: "TARGET" });
  });

  it("trails the stop and stops out on its own", async () => {
    const clock = { now: new Date("2026-11-02T10:05:00+05:30") };
    const scalper = await bookWithOpenScalp(clock);
    await scalperMonitorTick(deps(124.3)); // +0.5R → cost-covered breakeven
    expect((await scalper.snapshot("NIFTY")).positions[0]).toMatchObject({ stop: 123, trail: { stage: "BREAKEVEN" } });
    await scalperMonitorTick(deps(122.9));
    expect((await scalper.snapshot("NIFTY")).closed[0]).toMatchObject({ exitReason: "BREAKEVEN_STOP" });
  });

  it("squares off at 15:15 even without a fresh quote, and never reads a missing spot as a broken level", async () => {
    const clock = { now: new Date("2026-11-02T10:05:00+05:30") };
    const scalper = await bookWithOpenScalp(clock);
    await scalperMonitorTick(deps(121, null)); // spot quote failed
    expect((await scalper.snapshot("NIFTY")).positions).toHaveLength(1);
    clock.now = new Date("2026-11-02T15:16:00+05:30");
    await scalperMonitorTick(deps(null, null));
    expect((await scalper.snapshot("NIFTY")).closed[0]).toMatchObject({ exitReason: "SQUARE_OFF_15_15" });
  });
});
