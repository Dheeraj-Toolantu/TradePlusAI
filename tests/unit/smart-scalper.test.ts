import { describe, expect, it } from "vitest";
import { SmartScalper, analyzeMarket, findSpotSetup, valueOption, type ScalperBar, type ScalperContract } from "../../services/paper-trading/src/smart-scalper";

const T0 = Date.parse("2026-10-08T04:00:00Z") / 1000; // 09:30 IST
const at = (ist: string) => () => new Date(`2026-10-08T${ist}:00+05:30`);

/** Strong 1m uptrend, a pullback that ends at the nearest support, then a hammer off it. */
function uptrendWithPullback(): ScalperBar[] {
  const bars: ScalperBar[] = [];
  const push = (open: number, close: number, wick = 1.5) => bars.push({ time: T0 + bars.length * 60, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: 0 });
  let price = 25000;
  for (let index = 0; index < 54; index += 1) {
    const close = price + (index % 6 < 4 ? 10 : -4);
    push(price, close);
    price = close;
  }
  // Pull back until price sits just above the nearest support.
  for (let guard = 0; guard < 12; guard += 1) {
    const support = analyzeMarket(bars)!.supports[0].price;
    if (price - support <= 6) break;
    const close = Math.max(price - 7, support + 2);
    push(price, close, 0.5);
    price = close;
  }
  const support = analyzeMarket(bars)!.supports[0].price;
  // Hammer: wick through the support, close back above it.
  bars.push({ time: T0 + bars.length * 60, open: price, high: price + 3, low: support - 2, close: price + 2.5, volume: 0 });
  return bars;
}

function chain(spot: number, iv = 13): ScalperContract[] {
  const rows: ScalperContract[] = [];
  const atm = Math.round(spot / 50) * 50;
  for (let strike = atm - 300; strike <= atm + 300; strike += 50) {
    for (const contract of ["CALL", "PUT"] as const) {
      const itm = contract === "CALL" ? spot - strike : strike - spot;
      const delta = Math.min(0.95, Math.max(0.05, 0.5 + itm / 400));
      const premium = Math.round((Math.max(itm, 0) + 90 * Math.exp(-Math.abs(itm) / 250) * (iv / 13)) * 20) / 20;
      rows.push({ symbol: `NIFTY26O13${strike}${contract === "CALL" ? "CE" : "PE"}`, contract, expiry: "2026-10-13", strike, premium, bid: premium - 0.1, ask: premium + 0.1, openInterest: 500000, volume: 1000000, iv, delta: contract === "CALL" ? delta : -delta, theta: -8, lotSize: 65, tickSize: 0.05 });
    }
  }
  return rows;
}

describe("smart scalper market read", () => {
  it("finds the uptrend and a CE entry at support with a stop just below it", () => {
    const bars = uptrendWithPullback();
    const read = analyzeMarket(bars)!;
    expect(read.trend).toBe("UP");
    const setup = findSpotSetup(bars, read, "CE", 2)!;
    expect(setup).not.toBeNull();
    expect(setup.stop).toBeLessThan(setup.level.price);
    expect(setup.stop).toBeLessThan(bars.at(-1)!.low);
    expect(setup.gates.find((gate) => gate.label.includes("rejection"))?.passed).toBe(true);
  });

  it("splits premium into intrinsic and time value", () => {
    const [itmCall] = chain(25000).filter((row) => row.contract === "CALL" && row.strike === 24900);
    const value = valueOption(itmCall, 25000);
    expect(value.intrinsic).toBe(100);
    expect(value.timeValue).toBeCloseTo(itmCall.premium - 100, 2);
    expect(value.moneyness).toBe("ITM");
  });
});

describe("SmartScalper decisions", () => {
  it("scalps a CE at support in a clean trend with at least the minimum reward:risk", async () => {
    const bars = uptrendWithPullback();
    const spot = bars.at(-1)!.close;
    const scalper = new SmartScalper({ now: at("10:30"), hydrate: false });
    const result = await scalper.scan({ symbol: "NIFTY", spot, bars, contracts: chain(spot), autoEntries: true, settings: { maxLossPerTrade: 5000 } });
    expect(result.decision.mode).toBe("SCALP");
    expect(result.decision.side).toBe("CE");
    expect(result.decision.plan?.riskReward).toBeGreaterThanOrEqual(2);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].legs[0].symbol).toMatch(/CE$/);
    expect(result.positions[0].stop).toBeLessThan(result.positions[0].entry);
  });

  it("in manual mode only signals, and enters when the trader takes the signal", async () => {
    const bars = uptrendWithPullback();
    const spot = bars.at(-1)!.close;
    const scalper = new SmartScalper({ now: at("10:30"), hydrate: false });
    const signal = await scalper.scan({ symbol: "NIFTY", spot, bars, contracts: chain(spot), autoEntries: false, settings: { maxLossPerTrade: 5000 } });
    expect(signal.positions).toHaveLength(0);
    expect(signal.signalReady).toBe(true);
    expect(signal.summary).toContain("Take trade");
    const taken = await scalper.take("NIFTY", chain(spot), { settings: { maxLossPerTrade: 5000 } });
    expect(taken.positions).toHaveLength(1);
    expect(taken.positions[0].kind).toBe("SCALP");
    expect(taken.tradesToday).toBe(1);
    const again = await scalper.take("NIFTY", chain(spot));
    expect("error" in again && again.error).toContain("No fresh engine signal");
  });

  it("switches to a debit-spread hedge when options are expensive", async () => {
    const bars = uptrendWithPullback();
    const spot = bars.at(-1)!.close;
    const scalper = new SmartScalper({ now: at("10:30"), hydrate: false });
    const result = await scalper.scan({ symbol: "NIFTY", spot, bars, contracts: chain(spot, 26), autoEntries: true, settings: { maxLossPerTrade: 5000 } });
    expect(result.decision.mode).toBe("HEDGE");
    const plan = result.decision.plan!;
    expect(plan.legs.map((leg) => leg.side)).toEqual(["BUY", "SELL"]);
    expect(plan.legs[0].valuation.intrinsicPct).toBeGreaterThan(plan.legs[1].valuation.intrinsicPct);
    expect(plan.legs[1].valuation.intrinsic).toBe(0);
    expect(plan.entry).toBeLessThan(Math.abs(plan.legs[1].strike - plan.legs[0].strike));
  });

  it("waits outside the entry window", async () => {
    const bars = uptrendWithPullback();
    const spot = bars.at(-1)!.close;
    const result = await new SmartScalper({ now: at("15:05"), hydrate: false }).scan({ symbol: "NIFTY", spot, bars, contracts: chain(spot), autoEntries: true });
    expect(result.decision.mode).toBe("WAIT");
    expect(result.positions).toHaveLength(0);
  });

  it("exits when the spot breaks the support the trade was taken at", async () => {
    const bars = uptrendWithPullback();
    const spot = bars.at(-1)!.close;
    let now = at("10:30");
    const scalper = new SmartScalper({ now: () => now(), hydrate: false });
    const first = await scalper.scan({ symbol: "NIFTY", spot, bars, contracts: chain(spot), autoEntries: true, settings: { maxLossPerTrade: 5000 } });
    const spotStop = first.positions[0].spot!.stop;
    now = at("10:31");
    const broken = spotStop - 3;
    const after = await scalper.scan({ symbol: "NIFTY", spot: broken, bars, contracts: chain(broken), autoEntries: false });
    expect(after.positions).toHaveLength(0);
    expect(after.closed[0].exitReason).toBe("SPOT_LEVEL_BROKEN");
    expect(after.realizedPnl).toBeLessThan(0);
  });
});

describe("SmartScalper manual orders", () => {
  it("never writes naked options and closes longs on sell", async () => {
    const scalper = new SmartScalper({ now: at("10:30"), hydrate: false });
    const [call] = chain(25000).filter((row) => row.contract === "CALL" && row.strike === 25000);
    const naked = await scalper.sell("NIFTY", call, 1);
    expect("error" in naked && naked.error).toContain("Naked option writing is disabled");
    await scalper.buy("NIFTY", call, 2);
    const partial = await scalper.sell("NIFTY", { ...call, premium: call.premium + 10 }, 1);
    expect(partial.positions[0].quantity).toBe(65);
    expect(partial.realizedPnl).toBeGreaterThan(0);
    const done = await scalper.exit("NIFTY", "ALL");
    expect(done.positions).toHaveLength(0);
  });

  it("refuses manual buys after the 15:15 IST square-off", async () => {
    const [call] = chain(25000).filter((row) => row.contract === "CALL" && row.strike === 25000);
    const late = await new SmartScalper({ now: at("15:20"), hydrate: false }).buy("NIFTY", call, 1);
    expect("error" in late && late.error).toContain("09:15-15:15");
    expect(late.positions).toHaveLength(0);
  });
});
