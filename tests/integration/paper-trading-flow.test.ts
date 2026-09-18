import { describe, expect, it } from "vitest";
import { AutoPaperTrader } from "../../services/paper-trading/src/auto-paper-trader";

describe("paper trading flow", () => {
  it("creates a simulated entry after the short paper warm-up", async () => {
    const trader = new AutoPaperTrader();
    for (const price of [100, 101, 102]) {
      await trader.tick([{ symbol: "NIFTY", price, open: price, high: price, low: price, volume: 100, timestamp: new Date().toISOString() }]);
    }
    const status = trader.status();
    expect(status.account.orders).toBe(1);
    expect(status.positions[0]?.symbol).toBe("NIFTY");
    expect(status.events.at(-1)?.type).toBe("ENTRY");
  });
});