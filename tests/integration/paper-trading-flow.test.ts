import { describe, expect, it } from "vitest";
import { AutoPaperTrader } from "../../services/paper-trading/src/auto-paper-trader";

describe("paper trading flow", () => {
  it("does not trade a 3-tick warm-up, then enters on a confirmed trend and exits at target", async () => {
    const trader = new AutoPaperTrader();
    const at = (index: number) => new Date(Date.parse("2026-01-01T10:00:00+05:30") + index * 60_000).toISOString();
    const tick = (price: number, index: number) => trader.tick([{ symbol: "NIFTY", price, open: price, high: price, low: price, volume: 100, timestamp: at(index) }], at(index));
    for (const [index, price] of [100, 101, 102].entries()) await tick(price, index);
    expect(trader.status().account.orders).toBe(0);
    for (let index = 3; index < 19; index += 1) await tick(100 + index, index);
    await tick(120, 19);
    const status = trader.status();
    expect(status.account.orders).toBe(1);
    expect(status.positions[0]?.symbol).toBe("NIFTY");
    expect(status.events.at(-1)?.type).toBe("ENTRY");
    await tick(status.positions[0].target + 1, 20);
    expect(trader.status().positions).toHaveLength(0);
    expect(trader.status().account.realizedPnl).toBeGreaterThan(0);
  });
});
