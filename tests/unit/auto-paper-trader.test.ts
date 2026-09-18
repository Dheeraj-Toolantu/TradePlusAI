import { describe, expect, it } from "vitest";
import type { BrokerQuote } from "../../packages/broker-contracts/src/broker-adapter";
import { AutoPaperTrader } from "../../services/paper-trading/src/auto-paper-trader";

function quote(price: number, index: number): BrokerQuote { return { symbol: "NIFTY", price, open: price - 2, high: price + 3, low: price - 3, volume: 1000 + index * 10, timestamp: new Date(2026, 0, 1, 9, 15 + index).toISOString() }; }

describe("AutoPaperTrader", () => {
  it("waits for candle history and stays paper-only", async () => {
    const trader = new AutoPaperTrader();
    const result = await trader.tick(Array.from({ length: 19 }, (_, index) => quote(100 + index, index)));
    expect(result.positions).toHaveLength(0);
    expect(result.events.at(-1)?.type).toBe("WAITING");
    expect(result.mode).toBe("PAPER");
  });

  it("opens only after trend and bullish candle confirmation", async () => {
    const trader = new AutoPaperTrader();
    for (let index = 0; index < 19; index += 1) await trader.tick([quote(100 + index, index)]);
    const result = await trader.tick([{ ...quote(120, 20), open: 116, high: 123, low: 115 }]);
    expect(result.mode).toBe("PAPER");
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].side).toBe("LONG");
    expect(result.positions[0].target).toBeGreaterThan(result.positions[0].entry);
  });

  it("exits at the configured target", async () => {
    const trader = new AutoPaperTrader();
    for (let index = 0; index < 19; index += 1) await trader.tick([quote(100 + index, index)]);
    const entry = await trader.tick([{ ...quote(120, 20), open: 116, high: 123, low: 115 }]);
    const target = entry.positions[0].target;
    const result = await trader.tick([{ ...quote(target, 21), open: target - 1, high: target + 1, low: target - 2 }]);
    expect(result.positions).toHaveLength(0);
    expect(result.events.at(-1)?.type).toBe("EXIT");
  });
});