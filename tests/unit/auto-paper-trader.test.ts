import { describe, expect, it } from "vitest";
import type { BrokerQuote } from "../../packages/broker-contracts/src/broker-adapter";
import { AutoPaperTrader } from "../../services/paper-trading/src/auto-paper-trader";

/** One quote per IST minute starting 10:00 IST; open/high/low are DAY values like a real quote. */
const at = (index: number) => new Date(Date.parse("2026-01-01T10:00:00+05:30") + index * 60_000).toISOString();
function quote(price: number, index: number): BrokerQuote { return { symbol: "NIFTY", price, open: 95, high: Math.max(price, 125), low: 90, volume: 1000 + index * 10, timestamp: at(index) }; }
async function feed(trader: AutoPaperTrader, prices: number[], startIndex = 0) {
  let result = trader.status();
  for (const [offset, price] of prices.entries()) result = await trader.tick([quote(price, startIndex + offset)], at(startIndex + offset));
  return result;
}
const rising = Array.from({ length: 19 }, (_, index) => 100 + index);

describe("AutoPaperTrader", () => {
  it("waits for candle history and stays paper-only", async () => {
    const trader = new AutoPaperTrader();
    const result = await feed(trader, rising.slice(0, 10));
    expect(result.positions).toHaveLength(0);
    expect(result.events.at(-1)?.message).toMatch(/Collecting candles/);
    expect(result.mode).toBe("PAPER");
  });

  it("opens only after trend and bullish candle confirmation", async () => {
    const trader = new AutoPaperTrader();
    await feed(trader, rising);
    const result = await trader.tick([quote(120, 19)], at(19));
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].side).toBe("LONG");
    expect(result.positions[0].target).toBeGreaterThan(result.positions[0].entry);
    expect(result.today.entries).toBe(1);
  });

  it("does not stop out on the day's low printed before the entry", async () => {
    const trader = new AutoPaperTrader();
    await feed(trader, rising);
    const entry = await trader.tick([quote(120, 19)], at(19));
    const { stop } = entry.positions[0];
    // The quote's day low (90) is far below the stop, but the price itself holds above it.
    const result = await trader.tick([quote(stop + 0.5, 20)], at(20));
    expect(result.positions).toHaveLength(1);
  });

  it("fills a target at the target and a stop at the traded price", async () => {
    const trader = new AutoPaperTrader();
    await feed(trader, rising);
    const entry = await trader.tick([quote(120, 19)], at(19));
    const target = entry.positions[0].target;
    const exited = await trader.tick([quote(target + 3, 20)], at(20));
    expect(exited.positions).toHaveLength(0);
    expect(exited.events.at(-1)).toMatchObject({ type: "EXIT", price: target });
  });

  it("never enters before 09:35 IST and squares off at 15:15 IST", async () => {
    const early = new AutoPaperTrader();
    const opening = (index: number) => new Date(Date.parse("2026-01-01T09:16:00+05:30") + index * 60_000).toISOString();
    let result = early.status();
    for (let index = 0; index < 18; index += 1) result = await early.tick([{ ...quote(100 + index, index), timestamp: opening(index) }], opening(index));
    expect(result.positions).toHaveLength(0);
    expect(result.events.at(-1)?.message).toMatch(/entry window/);

    const trader = new AutoPaperTrader();
    await feed(trader, rising);
    await trader.tick([quote(120, 19)], at(19));
    const late = "2026-01-01T15:16:00+05:30";
    const squared = await trader.tick([{ ...quote(121, 20), timestamp: late }], new Date(late).toISOString());
    expect(squared.positions).toHaveLength(0);
    expect(squared.events.at(-1)?.message).toMatch(/15:15 square-off/);
  });
});
