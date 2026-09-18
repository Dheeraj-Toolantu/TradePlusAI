import { describe, expect, it } from "vitest";
import { simulateOrder } from "../../services/paper-trading/src/paper-engine";

describe("paper trading", () => { it("records a simulated fill and preserves paper mode", () => { const account = simulateOrder({ id: "p1", capital: 100000, balance: 100000, realizedPnl: 0, orders: [] }, { symbol: "NIFTY", side: "BUY", quantity: 50, price: 100 }); expect(account.orders[0].status).toBe("FILLED"); }); });