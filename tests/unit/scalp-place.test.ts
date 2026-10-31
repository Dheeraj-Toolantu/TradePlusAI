import { describe, expect, it } from "vitest";
import { SmartScalper, emaMomentumLost, valueOption, vwapEmaTrail, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";
import { riskRewardLayout } from "../../apps/web/components/scalper/premium-chart";

const at = (ist: string, day = "2026-11-02") => () => new Date(`${day}T${ist}:00+05:30`);

const contract: ScalperContract = {
  symbol: "NIFTY26N1024800CE", contract: "CALL", expiry: "2026-11-10", strike: 24800, premium: 120.45, bid: 120.05, ask: 120.85,
  openInterest: 500000, volume: 900000, iv: 13.5, delta: 0.576, theta: -9, lotSize: 65, tickSize: 0.05,
};

/** The VWAP-EMA scalper's confirmed 1:2 NIFTY plan (quant test_scalp_strategy). */
function plan(overrides: Partial<ScalperPlan> = {}): ScalperPlan {
  return {
    kind: "SCALP", side: "CE",
    legs: [{ symbol: contract.symbol, contract: "CALL", strike: 24800, side: "BUY", price: 120.85, valuation: valueOption(contract, 24819) }],
    lots: 1, quantity: 65, entry: 120.85, stop: 114.1, target: 133.95, riskPerLot: 438.75, rewardPerLot: 851.5, riskReward: 1.94,
    spot: { entry: 24819, stop: 24807.61, target: 24841.79 }, reason: "VWAP-EMA scalper 1:2: long NIFTY", ...overrides,
  };
}

describe("placing a VWAP-EMA scalp on the Smart Scalper", () => {
  it("opens a SCALP position with the planned stop distance and target", async () => {
    const scalper = new SmartScalper({ now: at("10:05"), hydrate: false });
    const result = await scalper.place("NIFTY", plan(), [contract], { setupId: "VWAP_EMA_SCALP:NIFTY:CE:09:40" });
    expect(result.placed).toBe(true);
    expect(result.positions).toHaveLength(1);
    const position = result.positions[0];
    expect(position).toMatchObject({ kind: "SCALP", side: "CE", target: 133.95, spot: { stop: 24807.61, target: 24841.79 } });
    expect(position.legs[0]).toMatchObject({ symbol: contract.symbol, side: "BUY", quantity: 65, entry: 120.85 });
    expect(Math.round((position.entry - (position.stop ?? 0)) * 100) / 100).toBe(6.75); // slippage costs reward, never the stop distance
    expect(result.tradesToday).toBe(1);
  });

  it("places a setup only once", async () => {
    const scalper = new SmartScalper({ now: at("10:05"), hydrate: false });
    await scalper.place("NIFTY", plan(), [contract], { setupId: "same" });
    const again = await scalper.place("NIFTY", plan(), [contract], { setupId: "same" });
    expect(again.placed).toBe(false);
    expect(again.error).toMatch(/already placed/);
  });

  it("keeps one engine position per index", async () => {
    const scalper = new SmartScalper({ now: at("10:05"), hydrate: false });
    await scalper.place("NIFTY", plan(), [contract], { setupId: "first" });
    const second = await scalper.place("NIFTY", plan(), [contract], { setupId: "second" });
    expect(second.placed).toBe(false);
    expect(second.error).toMatch(/already open/);
  });

  it("respects the kill switch, the trade cap and market hours", async () => {
    const blocked = await new SmartScalper({ now: at("10:05"), hydrate: false }).place("NIFTY", plan(), [contract], { setupId: "k", entryBlockedReason: "KILL_SWITCH_ACTIVE: operator" });
    expect(blocked).toMatchObject({ placed: false, error: expect.stringContaining("KILL_SWITCH_ACTIVE") });
    const capped = new SmartScalper({ now: at("10:05"), hydrate: false });
    const first = await capped.place("NIFTY", plan(), [contract], { setupId: "a", settings: { maxTrades: 1 } });
    await capped.exit("NIFTY", "ALL", [{ ...contract, premium: 134 }]); // a winner, so no loss cool-down
    expect(first.placed).toBe(true);
    const over = await capped.place("NIFTY", plan(), [contract], { setupId: "b", settings: { maxTrades: 1 } });
    expect(over.error).toMatch(/trade cap/);
    const late = await new SmartScalper({ now: at("15:20"), hydrate: false }).place("NIFTY", plan(), [contract], { setupId: "late" });
    expect(late.error).toMatch(/15:15/);
    const weekend = await new SmartScalper({ now: at("10:05", "2026-11-07"), hydrate: false }).place("NIFTY", plan(), [contract], { setupId: "sat" });
    expect(weekend.error).toMatch(/trading days/);
  });

  it("pauses after a loss, like the scalper's own entries", async () => {
    const scalper = new SmartScalper({ now: at("10:05"), hydrate: false });
    await scalper.place("NIFTY", plan(), [contract], { setupId: "loser" });
    await scalper.exit("NIFTY", "ALL", [{ ...contract, premium: 114 }]);
    const next = await scalper.place("NIFTY", plan(), [contract], { setupId: "next" });
    expect(next.error).toMatch(/cooling down/);
  });

  it("refuses a malformed plan", async () => {
    const result = await new SmartScalper({ now: at("10:05"), hydrate: false }).place("NIFTY", plan({ stop: 125 }), [contract], { setupId: "bad" });
    expect(result).toMatchObject({ placed: false, error: expect.stringContaining("stop below") });
  });
});

describe("risk-reward drawing on the premium chart", () => {
  const box = { entry: 120.85, stop: 114.1, target: 133.95 };
  const toY = (price: number) => (150 - price) * 10; // 1 rupee = 10 px, higher price = higher on screen

  it("puts the reward zone above the entry and the risk zone below it", () => {
    const layout = riskRewardLayout(box, toY, 600, 200)!;
    expect(layout.targetY).toBeLessThan(layout.entryY);
    expect(layout.stopY).toBeGreaterThan(layout.entryY);
    expect((layout.entryY - layout.targetY) / (layout.stopY - layout.entryY)).toBeCloseTo(1.94, 2);
    expect(layout.left).toBe(200);
    expect(layout.width).toBe(400);
  });

  it("starts at the trigger candle, or near the right edge without one, and hides off-scale prices", () => {
    expect(riskRewardLayout(box, toY, 600, null)!.left).toBe(330);
    expect(riskRewardLayout(box, toY, 600, 590)!.left).toBe(410); // always at least 190 px wide, so labels fit
    expect(riskRewardLayout(box, toY, 120, 100)!.width).toBe(120); // a narrow plot gets the whole width
    expect(riskRewardLayout(box, (price) => (price > 130 ? null : toY(price)), 600, 200)).toBeNull();
  });
});

describe("VWAP-EMA staged trail (systematic SL / target / trailing SL)", () => {
  const trail = { risk: 6.75, costPerUnit: 2.15, stage: "INITIAL" as const };
  const at10 = (minute: number) => Date.parse(`2026-11-02T10:${String(minute).padStart(2, "0")}:00+05:30`) / 1000;
  /** 1m index bars 09:35-10:04: a steady rise; `drop` makes the last completed bar close under the 9 EMA. */
  const bars = (drop = false) => Array.from({ length: 30 }, (_, i) => {
    const time = at10(4) - (29 - i) * 60;
    const close = 24790 + i * 1.2 - (drop && i === 29 ? 12 : 0);
    return { time, open: close - 0.5, high: close + 1, low: close - (drop && i === 29 ? 13 : 1), close, volume: 5000 };
  });

  it("moves the stop up in stages and never down", () => {
    expect(vwapEmaTrail({ entry: 120.85, stop: 114.1, highWater: 123, trail })).toEqual({ stop: 114.1, stage: "INITIAL" });
    expect(vwapEmaTrail({ entry: 120.85, stop: 114.1, highWater: 124.25, trail })).toEqual({ stop: 123, stage: "BREAKEVEN" }); // +0.5R → entry + charges
    expect(vwapEmaTrail({ entry: 120.85, stop: 123, highWater: 127.6, trail: { ...trail, stage: "BREAKEVEN" } })).toEqual({ stop: 124.23, stage: "LOCKED" }); // +1R → +0.5R locked
    expect(vwapEmaTrail({ entry: 120.85, stop: 124.23, highWater: 131, trail: { ...trail, stage: "LOCKED" } })).toEqual({ stop: 126.95, stage: "TRAILING" }); // 0.6R under the best premium
    expect(vwapEmaTrail({ entry: 120.85, stop: 126.95, highWater: 129, trail: { ...trail, stage: "TRAILING" } }).stop).toBe(126.95); // never lowered
  });

  it("detects a 1m close back through the 9 EMA on completed candles only", () => {
    const now = new Date(at10(5) * 1000);
    expect(emaMomentumLost(bars(), true, now)).toBe(false);
    expect(emaMomentumLost(bars(true), true, now)).toBe(true);
    expect(emaMomentumLost(bars(true), true, new Date(at10(4) * 1000 + 30_000))).toBe(false); // that candle is still forming
  });

  async function placed(clock: { now: Date }) {
    const scalper = new SmartScalper({ now: () => clock.now, hydrate: false });
    await scalper.place("NIFTY", plan({ trail: { rule: "VWAP_EMA", costPerUnit: 2.15 } }), [contract], { setupId: "trail" });
    return scalper;
  }
  const scanAt = (scalper: SmartScalper, premium: number, drop = false) => scalper.scan({ symbol: "NIFTY", spot: 24825, bars: bars(drop), contracts: [{ ...contract, premium, bid: premium, ask: premium }], autoEntries: false });

  it("manages a placed scalp through breakeven, lock and trail to a profitable trailing-stop exit", async () => {
    const clock = { now: new Date(at10(5) * 1000) };
    const scalper = await placed(clock);
    let state = await scanAt(scalper, 124.3);
    expect(state.positions[0]).toMatchObject({ stop: 123, trailing: true, trail: { stage: "BREAKEVEN" } });
    state = await scanAt(scalper, 127.7);
    expect(state.positions[0]).toMatchObject({ stop: 124.23, trail: { stage: "LOCKED" } });
    state = await scanAt(scalper, 131);
    expect(state.positions[0]).toMatchObject({ stop: 126.95, trail: { stage: "TRAILING" } });
    state = await scanAt(scalper, 126.9);
    expect(state.positions).toHaveLength(0);
    expect(state.closed[0]).toMatchObject({ exitReason: "TRAILING_STOP" });
    expect(state.closed[0].realizedPnl).toBeGreaterThan(0);
  });

  it("exits at a cost-covered breakeven instead of a loss once +0.5R was reached", async () => {
    const clock = { now: new Date(at10(5) * 1000) };
    const scalper = await placed(clock);
    await scanAt(scalper, 124.3);
    const state = await scanAt(scalper, 122.9);
    expect(state.closed[0]).toMatchObject({ exitReason: "BREAKEVEN_STOP" });
  });

  it("exits when momentum is lost after breakeven, and takes the target when it trades", async () => {
    const clock = { now: new Date(at10(5) * 1000) };
    const scalper = await placed(clock);
    await scanAt(scalper, 124.3);
    const lost = await scanAt(scalper, 124.5, true);
    expect(lost.closed[0]).toMatchObject({ exitReason: "EMA9_LOST" });
    const second = await placed(clock);
    const won = await scanAt(second, 134);
    expect(won.closed[0]).toMatchObject({ exitReason: "TARGET" });
  });

  it("keeps the initial stop for a loser", async () => {
    const clock = { now: new Date(at10(5) * 1000) };
    const scalper = await placed(clock);
    const state = await scanAt(scalper, 114);
    expect(state.closed[0]).toMatchObject({ exitReason: "STOP_LOSS" });
  });
});

describe("VWAP-EMA placement re-plans on the actual fill (defects 1 and 2)", () => {
  // The engine's plan (quant test_scalp_strategy): expected fill 121.25 = ask 120.85 + 0.3%, rounded
  // up; structural SL 113.70; target = fill + 2R = 136.35; tolerance 0.2R → max entry 122.75.
  const risk = { maxEntry: 122.75, maxTarget: 139.45, minRiskReward: 1.94, stopGap: 0.76, feesAtStopPerLot: 113.18, lotSize: 65 };
  const vwapPlan = (overrides: Partial<ScalperPlan> = {}) => plan({ entry: 121.25, stop: 113.7, target: 136.35, riskReward: 2, trail: { rule: "VWAP_EMA", costPerUnit: 2.13 }, risk, ...overrides });
  const quoted = (ask: number) => [{ ...contract, premium: ask - 0.4, bid: ask - 0.8, ask }];
  const scalperAt = () => new SmartScalper({ now: at("10:05"), hydrate: false, slippagePct: 0.003 });

  it("fills where the plan expected, keeps the structural stop and holds 2R on the fill", async () => {
    const result = await scalperAt().place("NIFTY", vwapPlan(), quoted(120.85), { setupId: "fill-ok", settings: { maxLossPerTrade: 1500 } });
    expect(result.placed).toBe(true);
    const position = result.positions[0];
    expect(position.entry).toBe(121.25); // ask + 0.3%, rounded up: the same price the plan used
    expect(position.stop).toBe(113.7); // NOT shifted by slippage: the structural SL
    expect(position.target).toBe(136.35);
    expect(position.trail?.risk).toBe(7.55);
    expect(position.fill).toMatchObject({ planned: 121.25, actual: 121.25, deviation: 0, riskReward: 2 });
  });

  it("re-plans a worse fill: same structural stop, R and target re-derived from the fill", async () => {
    const result = await scalperAt().place("NIFTY", vwapPlan(), quoted(121.1), { setupId: "worse" });
    expect(result.placed).toBe(true);
    const position = result.positions[0];
    expect(position.entry).toBe(121.5); // 121.10 + 0.3%, rounded up
    expect(position.stop).toBe(113.7); // unchanged
    expect(position.trail?.risk).toBe(7.8); // R grew with the worse fill
    expect(position.target).toBe(137.1); // 121.50 + 2 x 7.80: still 1:2 on the fill
    expect(position.fill).toMatchObject({ deviation: 0.25, riskReward: 2 });
  });

  it("caps a re-derived target at the OI wall and still places when the ratio holds", async () => {
    // wanted 137.10, wall cap 136.90: (136.90 − 121.50) / 7.80 = 1.97 ≥ 1.94
    const capped = await scalperAt().place("NIFTY", vwapPlan({ risk: { ...risk, maxTarget: 136.9 } }), quoted(121.1), { setupId: "wall" });
    expect(capped.placed).toBe(true);
    expect(capped.positions[0].target).toBe(136.9);
    expect(capped.positions[0].fill?.riskReward).toBe(1.97);
  });

  it("refuses a fill that drifted past the tolerance", async () => {
    const result = await scalperAt().place("NIFTY", vwapPlan(), quoted(122.5), { setupId: "drift" });
    expect(result).toMatchObject({ placed: false, error: expect.stringContaining("above the planned entry") });
    expect(result.positions).toHaveLength(0);
  });

  it("refuses when the wall-capped target leaves less than the chosen R:R", async () => {
    // fill 121.50, R 7.80, but the wall caps the target at 135.40: (135.40 − 121.50) / 7.80 = 1.78 < 1.94
    const result = await scalperAt().place("NIFTY", vwapPlan({ risk: { ...risk, maxTarget: 135.4 } }), quoted(121.1), { setupId: "rr" });
    expect(result).toMatchObject({ placed: false, error: expect.stringContaining("reward:risk is 1.78") });
  });

  it("sizes on the stressed loss: fewer lots, or none, when the max loss cannot absorb it", async () => {
    // stressed per lot at the 121.25 fill: (7.55 + 0.34 exit slippage + 0.76 gap) x 65 + 113.18 = ₹675
    const two = await scalperAt().place("NIFTY", vwapPlan({ lots: 3, quantity: 195 }), quoted(120.85), { setupId: "two", settings: { maxLossPerTrade: 1400 } });
    expect(two.positions[0].legs[0].quantity).toBe(130); // 2 lots fit ₹1,400, not 3
    expect(two.positions[0].fill!.stressedLoss).toBeLessThanOrEqual(1400);
    expect(two.positions[0].fill!.stressedLoss).toBeGreaterThan(two.positions[0].fill!.plannedLoss);
    const none = await scalperAt().place("NIFTY", vwapPlan(), quoted(120.85), { setupId: "none", settings: { maxLossPerTrade: 600 } });
    expect(none).toMatchObject({ placed: false, error: expect.stringContaining("stressed") });
  });
});
