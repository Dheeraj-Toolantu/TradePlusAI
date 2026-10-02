import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/web/lib/market-intel", () => ({ isIntelSymbol: () => false, getMarketIntel: async () => null }));
import { POST } from "../../apps/web/app/api/auto-option-trading/route";

const body = { symbol: "NIFTY", spot: 25000, candles: [1, 2, 3].map((i) => ({ timestamp: `2026-09-30T05:0${i}:00Z`, open: 25000, high: 25005, low: 24995, close: 25000, volume: 10 })), contracts: [{ symbol: "NIFTY25000CE", contract: "CALL", strike: 25000, premium: 100, delta: 0.5, score: 80, riskReward: 2, lotSize: 65, tickSize: 0.05 }] };

describe("auto option trading route", () => {
  afterEach(() => { delete process.env.ALGO_KILL_SWITCH; });
  it("keeps managing exits under the kill switch but takes no new entries", async () => {
    process.env.ALGO_KILL_SWITCH = "true";
    const response = await POST(new Request("http://localhost/api/auto-option-trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.summary).toMatch(/KILL_SWITCH_ACTIVE/);
    expect(result.summary).toMatch(/still managed/);
    expect(result.tradesTaken).toBe(0);
    expect(result.risk).toMatchObject({ openPositions: 0, consecutiveLosses: 0 });
  });
});
