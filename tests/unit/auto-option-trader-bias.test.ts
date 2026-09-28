import { describe, expect, it, vi } from "vitest";

// Hermetic: never touch the real Cloud Firestore project from unit tests.
vi.mock("../../apps/web/lib/firestore-orders", () => ({
  saveOrderToFirestore: vi.fn(async () => undefined),
  getActiveOrdersFromFirestore: vi.fn(async () => []),
}));

const { AutoOptionTrader } = await import("../../services/paper-trading/src/auto-option-trader");

const candles = [
  { timestamp: "2026-09-15T09:40:00+05:30", open: 23120, high: 23135, low: 23110, close: 23125, volume: 1000 },
  { timestamp: "2026-09-15T09:45:00+05:30", open: 23125, high: 23145, low: 23120, close: 23140, volume: 1200 },
  { timestamp: "2026-09-15T09:50:00+05:30", open: 23140, high: 23170, low: 23135, close: 23165, volume: 1500 },
];
const call = { symbol: "NIFTY2691523150CE", contract: "CALL" as const, strike: 23150, premium: 52, bid: 50.5, ask: 53.5, openInterest: 450000, volume: 4500000, iv: 28, delta: 0.52, score: 91, riskReward: 2.4, expiry: "2026-09-15", lotSize: 65, tickSize: 0.05, freezeQuantity: 1801 };

describe("AutoOptionTrader market-verdict gate", () => {
  it("takes a CALL when the verdict is bullish", async () => {
    const status = await new AutoOptionTrader().tick({ symbol: "NIFTY", spot: 23160, candles, contracts: [call], marketBias: "BULLISH" });
    expect(status.tradesTaken).toBe(1);
  });

  it("refuses a CALL when the verdict is bearish even if the local EMA trend is bullish", async () => {
    const status = await new AutoOptionTrader().tick({ symbol: "NIFTY", spot: 23160, candles, contracts: [call], marketBias: "BEARISH" });
    expect(status.tradesTaken).toBe(0);
    expect(status.diagnostics.join(" ")).toContain("market verdict BEARISH");
  });

  it("pauses entries but keeps managing exits when entries are blocked", async () => {
    const trader = new AutoOptionTrader();
    await trader.tick({ symbol: "NIFTY", spot: 23160, candles, contracts: [call], marketBias: "BULLISH" });
    const blocked = await trader.tick({ symbol: "NIFTY", spot: 23160, candles, contracts: [{ ...call, premium: 200 }], entryBlockedReason: "India VIX is in the EXTREME regime" });
    expect(blocked.summary).toContain("paused");
    expect(blocked.orders[0].status).toBe("EXITED");
    expect(blocked.orders[0].exitReason).toBe("AUTO_TARGET");
  });
});
