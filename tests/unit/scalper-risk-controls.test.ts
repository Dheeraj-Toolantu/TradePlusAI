import { describe, expect, it } from "vitest";
import { SmartScalper, valueOption, type ScalperContract, type ScalperPlan } from "../../services/paper-trading/src/smart-scalper";
import { nextSmartTrailStep, smartTrail } from "../../services/paper-trading/src/scalper-trail";

const at = (ist: string, day = "2026-11-02") => () => new Date(`${day}T${ist}:00+05:30`);
const contract: ScalperContract = {
  symbol: "NIFTY26N1024800CE", contract: "CALL", expiry: "2026-11-10", strike: 24800, premium: 120.45, bid: 120.05, ask: 120.85,
  openInterest: 500000, volume: 900000, iv: 13.5, delta: 0.576, theta: -9, lotSize: 65, tickSize: 0.05,
};
const plan = (): ScalperPlan => ({
  kind: "SCALP", side: "CE",
  legs: [{ symbol: contract.symbol, contract: "CALL", strike: 24800, side: "BUY", price: 120.85, valuation: valueOption(contract, 24819) }],
  lots: 1, quantity: 65, entry: 120.85, stop: 114.1, target: 133.95, riskPerLot: 438.75, rewardPerLot: 851.5, riskReward: 1.94,
  spot: { entry: 24819, stop: 24807.61, target: 24841.79 }, reason: "test scalp",
});
const quote = (premium: number) => [{ ...contract, premium, bid: premium, ask: premium }];
const tick = (book: SmartScalper, premium: number) => book.manage({ symbol: "NIFTY", spot: 24825, bars: [], contracts: quote(premium) });
async function placed(settings: Record<string, unknown> = {}) {
  const book = new SmartScalper({ now: at("10:05"), hydrate: false });
  const result = await book.place("NIFTY", plan(), [contract], { setupId: "x", settings });
  expect(result.placed).toBe(true);
  return { book, id: result.positions[0].id };
}

describe("smart auto trail (pure)", () => {
  const base = { entry: 100, stop: 90, target: null, risk: 10, costPerUnit: 1, tick: 0.05, runPastTarget: false, stage: "INITIAL" as const };
  it("leaves the stop alone below +0.75R, then breakeven + charges", () => {
    expect(smartTrail({ ...base, highWater: 107, value: 107 })).toMatchObject({ stop: 90, stage: "INITIAL" });
    expect(smartTrail({ ...base, highWater: 108, value: 108 })).toMatchObject({ stop: 101, stage: "BREAKEVEN" });
  });
  it("trails with a give-back that shrinks as the profit grows, and tightens before the close", () => {
    expect(smartTrail({ ...base, highWater: 115, value: 115 })).toMatchObject({ stop: 108.25, stage: "LOCKED" }); // 45% of +15
    expect(smartTrail({ ...base, highWater: 130, value: 130 })).toMatchObject({ stop: 122.5, stage: "TRAILING" }); // 25% of +30
    expect(smartTrail({ ...base, highWater: 130, value: 130, minutesToClose: 10 }).stop).toBe(125.5); // 15% late
  });
  it("never lowers the stop", () => {
    expect(smartTrail({ ...base, stop: 112, highWater: 115, value: 113 }).stop).toBe(112);
  });
  it("runs past the target: locks 80% of the move and pushes the target out", () => {
    expect(smartTrail({ ...base, target: 120, runPastTarget: true, highWater: 121, value: 121 })).toMatchObject({ stop: 116, target: 130, extended: true });
    expect(smartTrail({ ...base, target: 120, runPastTarget: false, highWater: 121, value: 121 })).toMatchObject({ target: 120, extended: false });
  });
  it("says what moves the stop next", () => {
    expect(nextSmartTrailStep({ entry: 100, risk: 10, costPerUnit: 1, stage: "INITIAL", highWater: 100 })).toMatchObject({ trigger: 107.5, stopTo: 101 });
  });
});

describe("Smart Scalper: SL, target and trailing on a taken trade", () => {
  it("puts every engine trade on the smart trail and lets a winner run past its target", async () => {
    const { book } = await placed();
    let out = await tick(book, 134); // the 133.95 target trades
    expect(out.exited).toHaveLength(0);
    const position = out.positions[0];
    expect(position.controls).toMatchObject({ mode: "SMART", runPastTarget: true, targetRuns: 1 });
    expect(position.stop).toBe(131.3); // 80% of the move to the target is locked
    expect(position.target).toBe(140.7); // and the target moved out
    out = await tick(book, 131);
    expect(out.exited[0]).toMatchObject({ exitReason: "RUNNER_STOP" });
    expect(out.exited[0].realizedPnl).toBeGreaterThan(0);
  });

  it("uses only the strategy's rule when the smart trail is switched off", async () => {
    const { book } = await placed({ smartTrail: false });
    const out = await tick(book, 134);
    expect(out.exited[0]).toMatchObject({ exitReason: "TARGET" });
  });

  it("modifies SL and target at any time, refusing levels on the wrong side of the live premium", async () => {
    const { book, id } = await placed();
    await tick(book, 122);
    expect((await book.modify("NIFTY", id, { stop: 125 })).error).toMatch(/below the live premium/);
    expect((await book.modify("NIFTY", id, { target: 121 })).error).toMatch(/above the live premium/);
    const result = await book.modify("NIFTY", id, { stop: 117, target: 140 });
    expect(result).toMatchObject({ modified: true, position: { stop: 117, target: 140 } });
    expect((await book.modify("NIFTY", "nope", { stop: 1 })).error).toMatch(/not open/);
  });

  it("keeps a stop moved by hand until the premium makes a new best, then the trail resumes", async () => {
    const { book, id } = await placed();
    let out = await tick(book, 130);
    expect(out.positions[0].stop).toBeGreaterThan(125);
    await book.modify("NIFTY", id, { stop: 119 });
    out = await tick(book, 129);
    expect(out.positions[0].stop).toBe(119);
    out = await tick(book, 131);
    expect(out.positions[0].stop).toBeGreaterThan(125);
  });

  it("trails a fixed distance under the best premium", async () => {
    const { book, id } = await placed();
    expect((await book.modify("NIFTY", id, { trailMode: "FIXED" })).error).toMatch(/fixed trail needs a distance/);
    await book.modify("NIFTY", id, { trailMode: "FIXED", trailPoints: 3 });
    let out = await tick(book, 128);
    expect(out.positions[0].stop).toBe(125);
    out = await tick(book, 124.9);
    expect(out.exited[0]).toMatchObject({ exitReason: "TRAILING_STOP" });
  });

  it("with trailing off the stop stays put and the target closes the trade", async () => {
    const { book, id } = await placed();
    await book.modify("NIFTY", id, { trailMode: "OFF" });
    let out = await tick(book, 132);
    expect(out.positions[0].stop).toBe(114.1);
    out = await tick(book, 134);
    expect(out.exited[0]).toMatchObject({ exitReason: "TARGET" });
  });

  it("adds a stop loss, target and smart trail to a manual buy", async () => {
    const book = new SmartScalper({ now: at("10:05"), hydrate: false });
    const bought = await book.buy("NIFTY", { ...contract, premium: 120.85, ask: 120.85 }, 1);
    const id = bought.positions[0].id;
    expect(bought.positions[0].controls?.mode).toBe("OFF");
    expect((await book.modify("NIFTY", id, { trailMode: "RULE" })).error).toMatch(/no strategy rule/);
    const result = await book.modify("NIFTY", id, { stop: 115, target: 128, trailMode: "SMART", runPastTarget: false });
    expect(result.position).toMatchObject({ stop: 115, target: 128, controls: { mode: "SMART", risk: 5.85 } });
    const out = await tick(book, 128.5);
    expect(out.exited[0]).toMatchObject({ kind: "MANUAL", exitReason: "TARGET" });
  });

  it("closes a manual buy at its stop loss", async () => {
    const book = new SmartScalper({ now: at("10:05"), hydrate: false });
    const id = (await book.buy("NIFTY", { ...contract, premium: 120.85, ask: 120.85 }, 1)).positions[0].id;
    await book.modify("NIFTY", id, { stop: 116 });
    const out = await tick(book, 115.5);
    expect(out.exited[0]).toMatchObject({ exitReason: "STOP_LOSS" });
  });
});
