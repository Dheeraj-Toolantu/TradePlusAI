import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartScalper, valueOption, type PositionView, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";
import { ensureVwapAutoTrader, resetVwapAutoTrader, setVwapAutoTrader, vwapAutoTraderStatus, vwapAutoTraderTick, type AutoTraderConfig, type AutoTraderDeps } from "../../apps/web/lib/vwap-auto-trader";

const at = (ist: string, day = "2026-11-02") => () => new Date(`${day}T${ist}:00+05:30`);
const contract = (symbol: string, strike: number): ScalperContract => ({ symbol, contract: "CALL", expiry: "2026-11-10", strike, premium: 120.45, bid: 120.05, ask: 120.85, openInterest: 1, volume: 1, iv: 13.5, delta: 0.576, theta: -9, lotSize: 65, tickSize: 0.05 });
const plan = (item: ScalperContract): ScalperPlan => ({
  kind: "SCALP", side: "CE", legs: [{ symbol: item.symbol, contract: "CALL", strike: item.strike, side: "BUY", price: 120.85, valuation: valueOption(item, item.strike) }],
  lots: 1, quantity: 65, entry: 120.85, stop: 114.1, target: 133.95, riskPerLot: 438.75, rewardPerLot: 851.5, riskReward: 1.94,
  spot: { entry: 24819, stop: 24807.61, target: 24841.79 }, reason: "VWAP-EMA", trail: { rule: "VWAP_EMA", costPerUnit: 0.6 },
});

describe("one VWAP-EMA trade at a time", () => {
  it("refuses a new trade on any index until the open one exits, then allows the next", async () => {
    const nifty = contract("NIFTY26N1024800CE", 24800);
    const bank = contract("BANKNIFTY26N1054000CE", 54000);
    const scalper = new SmartScalper({ now: at("10:05"), hydrate: false });
    expect((await scalper.place("NIFTY", plan(nifty), [nifty], { setupId: "a" })).placed).toBe(true);
    const blocked = await scalper.place("BANKNIFTY", plan(bank), [bank], { setupId: "b" });
    expect(blocked).toMatchObject({ placed: false, blockedByOpenTrade: true });
    expect(blocked.error).toMatch(/no new trade until it exits at its target, SL or trailing SL/);
    expect(scalper.openEngineTrade()?.underlying).toBe("NIFTY");
    // Target hit → the trade is closed by the scalper → the next setup may enter.
    await scalper.manage({ symbol: "NIFTY", spot: 24850, bars: [], contracts: [{ ...nifty, premium: 134.5 }] });
    expect(scalper.openEngineTrade()).toBeNull();
    expect((await scalper.place("BANKNIFTY", plan(bank), [bank], { setupId: "c" })).placed).toBe(true);
  });
});

function harness(overrides: Partial<AutoTraderDeps> = {}, clock = "10:05") {
  let saved: AutoTraderConfig | null = null;
  let open: PositionView | null = null;
  const place = vi.fn(async () => ({ status: 403, body: { placed: false, error: "V5 no-trade gate: the scalp is not confirmed on the server.", reasons: ["RETEST_NOT_CONFIRMED"] } as Record<string, unknown> }));
  const deps: AutoTraderDeps = {
    place, openTrade: async () => open, now: () => at(clock)().getTime(),
    load: async () => saved, save: async (config) => { saved = structuredClone(config); }, ...overrides,
  };
  ensureVwapAutoTrader("http://test", deps);
  return { deps, place, setOpen: (value: PositionView | null) => { open = value; }, saved: () => saved };
}

describe("server-side auto-execution", () => {
  afterEach(() => resetVwapAutoTrader());

  it("does nothing until switched on, then runs the strategy for the watched index and saves the switch", async () => {
    const h = harness();
    expect(await vwapAutoTraderTick()).toEqual({ skipped: "off" });
    expect(h.place).not.toHaveBeenCalled();
    const status = await setVwapAutoTrader({ index: "nifty", enabled: true, riskReward: "1:2" });
    expect(status).toMatchObject({ enabled: true, indices: ["NIFTY"], riskReward: "1:2" });
    expect(h.saved()).toMatchObject({ enabled: true, indices: ["NIFTY"] });
    await vwapAutoTraderTick();
    expect(h.place).toHaveBeenCalledWith({ underlying: "NIFTY", riskReward: "1:2", settings: {} });
    expect(vwapAutoTraderStatus().lastByIndex.NIFTY).toMatchObject({ status: "WAITING", text: expect.stringContaining("RETEST_NOT_CONFIRMED") });
  });

  it("places a confirmed setup, then waits while that trade is open and resumes after it exits", async () => {
    const position = { label: "NIFTY26N1024800CE", underlying: "NIFTY", entry: 121.25, stop: 113.7, target: 136.35, trail: { stage: "INITIAL" } } as unknown as PositionView;
    const h = harness({ place: vi.fn(async () => ({ status: 200, body: { placed: true, summary: "SCALP placed: BUY NIFTY26N1024800CE", position } })) });
    await setVwapAutoTrader({ index: "NIFTY", enabled: true });
    await setVwapAutoTrader({ index: "BANKNIFTY", enabled: true });
    expect(await vwapAutoTraderTick()).toEqual({ placed: "NIFTY" }); // one trade: BANKNIFTY is not tried
    expect(h.deps.place).toHaveBeenCalledTimes(1);
    expect(vwapAutoTraderStatus().lastPlacedAt).not.toBeNull();
    h.setOpen(position);
    expect(await vwapAutoTraderTick()).toEqual({ skipped: "in-trade" });
    expect(h.deps.place).toHaveBeenCalledTimes(1); // no strategy run while the trade is open
    expect(vwapAutoTraderStatus().openTrade).toMatchObject({ label: "NIFTY26N1024800CE", stop: 113.7 });
    h.setOpen(null); // target / SL / trailing SL hit
    expect(await vwapAutoTraderTick()).toEqual({ placed: "NIFTY" }); // the next confirmed setup enters
    expect(vwapAutoTraderStatus().events.some((event) => event.status === "CLOSED")).toBe(true);
    expect(h.deps.place).toHaveBeenCalledTimes(2);
  });

  it("never enters outside 09:15-15:15 IST or on weekends", async () => {
    const late = harness({}, "15:16");
    await setVwapAutoTrader({ index: "NIFTY", enabled: true });
    expect(await vwapAutoTraderTick()).toEqual({ skipped: "hours" });
    expect(late.place).not.toHaveBeenCalled();
  });

  it("restores the saved switch after a restart and turns off per index", async () => {
    harness({ load: async () => ({ enabled: true, indices: ["SENSEX", "BOGUS"], riskReward: "1:1", settings: { lots: 2 } }) });
    expect(await vwapAutoTraderTick()).toEqual({ placed: null });
    expect(vwapAutoTraderStatus()).toMatchObject({ enabled: true, indices: ["SENSEX"], riskReward: "1:1" });
    expect(await setVwapAutoTrader({ index: "SENSEX", enabled: false })).toMatchObject({ enabled: false, indices: [] });
    await expect(setVwapAutoTrader({ index: "RELIANCE", enabled: true })).rejects.toThrow(/index options/);
  });
});
