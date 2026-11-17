import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartScalper, valueOption, type PositionView, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";
import { SNIPER_TRAIL, nextSniperTrailStep, sniperTrail } from "../../services/paper-trading/src/scalper-trail";
import { ensureVwapAutoTrader, resetVwapAutoTrader, setVwapAutoTrader, vwapAutoTraderStatus, vwapAutoTraderTick, type AutoTraderConfig, type AutoTraderDeps } from "../../apps/web/lib/vwap-auto-trader";
import { sniperJournalRecord } from "../../apps/web/lib/sniper-journal";

const at = (ist: string, day = "2026-11-17") => () => new Date(`${day}T${ist}:00+05:30`);
let clock = at("10:21");
const contract = (premium = 31): ScalperContract => ({ symbol: "NIFTY25N1724000CE", contract: "CALL", expiry: "2026-11-17", strike: 24000, premium, bid: 0, ask: 0, openInterest: 500000, volume: 900000, iv: 14, delta: 0.52, theta: -18, lotSize: 65, tickSize: 0.05 });

/** The plan the algo route builds from a CONFIRMED sniper setup (route.ts sniperPlan). */
function sniperPlan(item: ScalperContract, overrides: Partial<ScalperPlan> = {}): ScalperPlan {
  return {
    kind: "SCALP", side: "CE", legs: [{ symbol: item.symbol, contract: "CALL", strike: item.strike, side: "BUY", price: 31.1, valuation: valueOption(item, 24004) }],
    lots: 1, quantity: 65, entry: 31.1, stop: 23.35, target: 62.2, riskPerLot: 503.75, rewardPerLot: 2021.5, riskReward: 4,
    spot: { entry: 24004, stop: 23939, target: 24058 }, reason: "NIFTY Sniper AI · liquidity reversal", trail: { rule: "SNIPER", costPerUnit: 1.2 },
    risk: { maxEntry: 31.7, maxTarget: 0, minRiskReward: 3.88, stopGap: 0.78, feesAtStopPerLot: 45, lotSize: 65, premiumMultiples: { stop: 0.75, target: 2 } },
    ...overrides,
  };
}
const scalper = () => new SmartScalper({ now: () => clock(), hydrate: false, slippagePct: 0.003 });

describe("NIFTY Sniper staged trail (multiples of the fill)", () => {
  it("moves the stop at 1.25x, 1.5x and 1.75x and never lowers it", () => {
    const base = { entry: 100, stop: 75, trail: { costPerUnit: 1.5, stage: "INITIAL" as const } };
    expect(sniperTrail({ ...base, highWater: 120 })).toEqual({ stop: 75, stage: "INITIAL" });
    expect(sniperTrail({ ...base, highWater: 125 })).toEqual({ stop: 101.5, stage: "BREAKEVEN" });
    expect(sniperTrail({ ...base, highWater: 150 })).toEqual({ stop: 120, stage: "LOCKED" });
    expect(sniperTrail({ ...base, highWater: 180 })).toEqual({ stop: 160, stage: "TRAILING" });
    expect(sniperTrail({ ...base, stop: 170, highWater: 180, trail: { costPerUnit: 1.5, stage: "TRAILING" } }).stop).toBe(170);
    expect(nextSniperTrailStep({ entry: 100, costPerUnit: 1.5, stage: "INITIAL", highWater: 100 })).toMatchObject({ trigger: 125, stopTo: 101.5 });
    expect(SNIPER_TRAIL.tightenAt).toBe(1.75);
  });
});

describe("Smart Scalper: sniper placement and exits", () => {
  afterEach(() => { clock = at("10:21"); });

  it("re-derives the 25% stop and 2x target from the ACTUAL fill, not the requested price", async () => {
    const book = scalper();
    const live = { ...contract(31.4) };
    const result = await book.place("NIFTY", sniperPlan(live), [live], { setupId: "s1", settings: { maxLossPerTrade: 1500 } });
    expect(result.placed).toBe(true);
    const position = result.position!;
    expect(position.entry).toBe(31.5); // 31.4 × 1.003 rounded up to the tick
    expect(position.stop).toBe(23.65); // 0.75 × 31.5 on the tick
    expect(position.target).toBe(63); // 2 × 31.5
    expect(position.trail).toMatchObject({ rule: "SNIPER", stage: "INITIAL" });
  });

  it("refuses a fill that drifted beyond the plan's tolerance", async () => {
    const live = contract(33);
    const result = await scalper().place("NIFTY", sniperPlan(live), [live], { setupId: "s2" });
    expect(result).toMatchObject({ placed: false });
    expect(result.error).toMatch(/above the planned entry/);
  });

  it("exits at 2x on the premium, not on an index 'target', and on the index invalidation", async () => {
    const book = scalper();
    const live = contract(31);
    await book.place("NIFTY", sniperPlan(live), [live], { setupId: "s3" });
    // The index passes the plan's spot target, the premium is short of 2x: still open.
    let out = await book.manage({ symbol: "NIFTY", spot: 24100, bars: [], contracts: [contract(50)] });
    expect(out.exited).toHaveLength(0);
    out = await book.manage({ symbol: "NIFTY", spot: 24120, bars: [], contracts: [contract(64)] });
    expect(out.exited[0]).toMatchObject({ exitReason: "TARGET_2X" });

    const other = scalper();
    await other.place("NIFTY", sniperPlan(live), [live], { setupId: "s4" });
    out = await other.manage({ symbol: "NIFTY", spot: 23930, bars: [], contracts: [contract(29)] });
    expect(out.exited[0]).toMatchObject({ exitReason: "SPOT_LEVEL_BROKEN" });
  });

  it("closes a trade that has not reached 1.25x after 90 minutes", async () => {
    const book = scalper();
    const live = contract(31);
    await book.place("NIFTY", sniperPlan(live), [live], { setupId: "s5" });
    clock = at("11:30");
    expect((await book.manage({ symbol: "NIFTY", spot: 24010, bars: [], contracts: [contract(33)] })).exited).toHaveLength(0);
    clock = at("11:52");
    expect((await book.manage({ symbol: "NIFTY", spot: 24010, bars: [], contracts: [contract(33)] })).exited[0]).toMatchObject({ exitReason: "SNIPER_TIME_STOP" });
  });

  it("enforces the sniper's own locks: 2 consecutive losses, 3 entries a day", async () => {
    const limits = { maxTrades: 3, maxConsecutiveLosses: 2 };
    const book = scalper();
    const settings = { maxTrades: 10, maxDailyLoss: 100000, maxLossPerTrade: 1500 };
    for (const [n, time] of [[1, "10:21"], [2, "10:40"]] as const) {
      clock = at(time);
      const live = contract(31);
      expect((await book.place("NIFTY", sniperPlan(live), [live], { setupId: `loss${n}`, settings, ruleLimits: limits })).placed).toBe(true);
      await book.manage({ symbol: "NIFTY", spot: 24000, bars: [], contracts: [contract(20)] }); // stop hit
    }
    clock = at("11:00");
    const live = contract(31);
    const third = await book.place("NIFTY", sniperPlan(live), [live], { setupId: "loss3", settings, ruleLimits: limits });
    expect(third.placed).toBe(false);
    expect(third.error).toMatch(/consecutive-loss lock/);
    expect(await book.ruleStats("SNIPER")).toMatchObject({ trades: 2, consecutiveLosses: 2 });
  });
});

function harness() {
  let saved: AutoTraderConfig | null = null;
  const place = vi.fn(async () => ({ status: 403, body: { placed: false, error: "V5 no-trade gate: the NIFTY Sniper setup is not confirmed on the server.", reasons: ["SCORE_BELOW_MINIMUM"], strategyReason: "Liquidity Reversal CALL · score 75 (STRONG) · blocked by SCORE_MINIMUM" } as Record<string, unknown> }));
  const deps: AutoTraderDeps = { place, openTrade: async () => null as PositionView | null, now: () => at("10:21")().getTime(), load: async () => saved, save: async (config) => { saved = structuredClone(config); } };
  ensureVwapAutoTrader("http://test", deps);
  return { place, saved: () => saved };
}

describe("auto-trader runs the selected strategy", () => {
  afterEach(() => resetVwapAutoTrader());

  it("selecting NIFTY Sniper runs it on NIFTY only and passes the strategy to placement", async () => {
    const h = harness();
    await expect(setVwapAutoTrader({ index: "BANKNIFTY", enabled: true, strategy: "NIFTY_SNIPER" })).rejects.toThrow(/NIFTY only/);
    const status = await setVwapAutoTrader({ index: "NIFTY", enabled: true, strategy: "NIFTY_SNIPER" });
    expect(status).toMatchObject({ enabled: true, strategy: "NIFTY_SNIPER", indices: ["NIFTY"] });
    expect(h.saved()).toMatchObject({ strategy: "NIFTY_SNIPER" });
    await vwapAutoTraderTick();
    expect(h.place).toHaveBeenCalledWith(expect.objectContaining({ underlying: "NIFTY", strategy: "NIFTY_SNIPER" }));
    expect(vwapAutoTraderStatus().lastByIndex.NIFTY.text).toMatch(/NIFTY Sniper AI: waiting for a confirmed setup \(Liquidity Reversal/);
  });

  it("switching from VWAP-EMA to the sniper drops indices the sniper does not trade", async () => {
    harness();
    await setVwapAutoTrader({ index: "BANKNIFTY", enabled: true });
    await setVwapAutoTrader({ index: "NIFTY", enabled: true });
    const status = await setVwapAutoTrader({ index: "NIFTY", enabled: true, strategy: "NIFTY_SNIPER" });
    expect(status).toMatchObject({ strategy: "NIFTY_SNIPER", indices: ["NIFTY"] });
  });
});

describe("sniper journal", () => {
  it("records the score, filters, lifecycle and V5 gates of every attempt", () => {
    const record = sniperJournalRecord({
      underlying: "NIFTY", origin: "AUTO_TRADER", placed: false, reasons: ["SCORE_BELOW_MINIMUM"],
      analysis: { strategy_reason: "blocked", pipeline: { decision: "NO_TRADE", reasons: ["SCORE_BELOW_MINIMUM"] }, calculations: { sniper: { state: "WATCH", family: "LIQUIDITY_REVERSAL", direction: "CALL", config_version: "sniper-1.0.0", score: { total: 75 }, components: [{ key: "oi", score: 0 }], hard_filters: [{ code: "SCORE_MINIMUM", passed: false }] } } },
    }, new Date("2026-11-17T04:51:00Z"));
    expect(record).toMatchObject({ strategy: "NIFTY_SNIPER", state: "WATCH", family: "LIQUIDITY_REVERSAL", configVersion: "sniper-1.0.0", placed: false, score: { total: 75 } });
    expect(record.id).toBe("202611170451-NIFTY-WATCH");
  });
});
