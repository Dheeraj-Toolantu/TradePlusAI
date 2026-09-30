import { describe, expect, it } from "vitest";
import { AutoOptionTrader } from "../../services/paper-trading/src/auto-option-trader";

const candles = [
  { timestamp: "2026-09-15T10:05:00+05:30", open: 23160, high: 23165, low: 23140, close: 23145, volume: 1000 },
  { timestamp: "2026-09-15T10:10:00+05:30", open: 23145, high: 23150, low: 23135, close: 23140, volume: 1000 },
  { timestamp: "2026-09-15T10:15:00+05:30", open: 23140, high: 23152, low: 23138, close: 23150, volume: 1000 },
];
const call = { symbol: "NIFTY2691523150CE", contract: "CALL" as const, strike: 23150, premium: 100, bid: 99, ask: 101, openInterest: 450000, volume: 4500000, iv: 14, delta: 0.5, score: 82, riskReward: 2, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 };
const put = { ...call, symbol: "NIFTY2691523150PE", contract: "PUT" as const, delta: -0.5 };
const orbBuy = { id: "ORB_RETEST:NIFTY:2026-09-15T10:10:00", strategy: "ORB_RETEST", side: "BUY" as const, entry: 23150, stopLoss: 23110, target: 23230 };

describe("AutoOptionTrader strategy-signal entries", () => {
  it("buys a CE on a fresh ORB signal even when the trend verdict is SIDEWAYS", async () => {
    const status = await new AutoOptionTrader().tick({ symbol: "NIFTY", spot: 23150, candles, contracts: [put, call], marketBias: "SIDEWAYS", trendBlockedReason: "no clear trend", strategySignal: orbBuy });
    expect(status.tradesTaken).toBe(1);
    const order = status.orders[0];
    expect(order.symbol).toBe(call.symbol);
    // 40-pt spot risk x 0.5 delta = 20 premium; 80-pt reward x 0.5 = 40.
    expect(order.stopLoss).toBe(80);
    expect(order.target).toBe(140);
  });

  it("takes each signal only once", async () => {
    const trader = new AutoOptionTrader();
    await trader.tick({ symbol: "NIFTY", spot: 23150, candles, contracts: [call], strategySignal: orbBuy, trendBlockedReason: "no clear trend" });
    const again = await trader.tick({ symbol: "NIFTY", spot: 23150, candles, contracts: [{ ...call, symbol: "NIFTY2691523200CE", strike: 23200 }], strategySignal: orbBuy, trendBlockedReason: "no clear trend" });
    expect(again.tradesTaken).toBe(1);
    expect(again.diagnostics.join(" ")).toContain("already traded");
  });

  it("does not fight an opposing market verdict", async () => {
    const status = await new AutoOptionTrader().tick({ symbol: "NIFTY", spot: 23150, candles, contracts: [call], marketBias: "BEARISH", strategySignal: orbBuy });
    expect(status.tradesTaken).toBe(0);
    expect(status.diagnostics.join(" ")).toContain("opposes");
  });

  it("clamps the premium stop to 35% for a very wide structural stop", async () => {
    const status = await new AutoOptionTrader().tick({ symbol: "NIFTY", spot: 23150, candles, contracts: [call], strategySignal: { ...orbBuy, stopLoss: 22950, target: 23550 } });
    expect(status.orders[0].stopLoss).toBe(65);
  });

  it("keeps trend-only entries paused without a signal", async () => {
    const status = await new AutoOptionTrader().tick({ symbol: "NIFTY", spot: 23150, candles, contracts: [call], trendBlockedReason: "no clear trend" });
    expect(status.tradesTaken).toBe(0);
    expect(status.summary).toContain("Waiting for a strategy signal");
  });
});
