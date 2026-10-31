import { describe, expect, it, vi } from "vitest";
import { POST } from "../../apps/web/app/api/algo-trading/route";
import { firestoreFake } from "../setup/firestore-fake";

// Hermetic contract master: never download Groww's live instrument CSV in tests.
vi.mock("../../adapters/groww/src/groww-instruments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../adapters/groww/src/groww-instruments")>();
  const fixture = {
    exchange: "NSE", exchangeToken: "71234", tradingSymbol: "NIFTY2691523300PE", growwSymbol: "NIFTY2691523300PE", instrumentType: "PE", segment: "FNO",
    underlyingSymbol: "NIFTY", expiryDate: "2026-09-15", strikePrice: 23300, lotSize: 65, tickSize: 0.05, freezeQuantity: 1801, isReserved: false, buyAllowed: true, sellAllowed: true,
  };
  return { ...actual, loadGrowwInstrumentCatalog: async () => new actual.GrowwInstrumentCatalog([fixture]) };
});

const requestFor = (body: Record<string, unknown>) => new Request("http://localhost/api/algo-trading", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("algo trading execution boundary", () => {
  it("hard-blocks every live request before broker invocation", async () => {
    const response = await POST(requestFor({ mode: "ALGO_LIVE", confirmLive: true, releaseEvidenceComplete: true }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("LIVE_EXECUTION_DISABLED") });
  });

  it("rejects a client confirmation without complete contract metadata", async () => {
    const response = await POST(requestFor({
      mode: "PAPER",
      analysisDecision: "CONFIRMED",
      strategy: "ORB_RETEST",
      symbol: "NIFTY",
      side: "BUY",
      quantity: 25,
      price: 100,
      target: 120,
      stopLoss: 90,
      lotSize: 25,
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("complete live contract metadata") });
  });

  it("accepts a valid manual paper order even when the broker health check is unavailable", async () => {
    const response = await POST(requestFor({
      mode: "PAPER",
      orderSource: "MANUAL",
      strategy: "ORB_RETEST",
      strategyName: "ORB + Retest",
      underlying: "NIFTY",
      symbol: "NIFTY2691523300PE",
      side: "BUY",
      quantity: 65,
      price: 37.65,
      target: 53,
      stopLoss: 30,
      lotSize: 65,
      expiry: "2026-09-15",
      growwSymbol: "NIFTY2691523300PE",
      optionType: "PE",
      strike: 23300,
      tickSize: 0.05,
      freezeQuantity: 1801,
      contractActive: true,
      analysisDecision: "CONFIRMED",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "PAPER",
      firestoreSynced: true,
      order: expect.objectContaining({
        symbol: "NIFTY2691523300PE",
        side: "BUY",
        quantity: 65,
        status: "OPEN",
      }),
    });
    expect(firestoreFake.documents("orders")).toEqual([expect.objectContaining({ symbol: "NIFTY2691523300PE", status: "OPEN" })]);
  });

  const scalpTicket = (overrides: Record<string, unknown>) => requestFor({
    mode: "PAPER", orderSource: "MANUAL", strategy: "VWAP_EMA_SCALP", strategyName: "VWAP-EMA Scalper", underlying: "NIFTY",
    symbol: "NIFTY2691523300PE", growwSymbol: "NIFTY2691523300PE", side: "BUY", quantity: 65, price: 52.5, lotSize: 65, expiry: "2026-09-15",
    optionType: "PE", strike: 23300, tickSize: 0.05, freezeQuantity: 1801, contractActive: true, ...overrides,
  });

  it("lets the scalper trade the 1:1 the trader chose", async () => {
    const response = await POST(scalpTicket({ target: 57, stopLoss: 48, riskReward: "1:1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ order: expect.objectContaining({ strategy: "VWAP_EMA_SCALP", target: 57, stopLoss: 48 }) });
  });

  it("holds a 1:2 scalp to its 1.94R premium minimum", async () => {
    const response = await POST(scalpTicket({ target: 59.25, stopLoss: 48, riskReward: "1:2" }));  // 1.5R
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("1.94R") });
  });

  it("keeps the 2R minimum for every other strategy", async () => {
    const response = await POST(scalpTicket({ strategy: "ORB_RETEST", target: 57, stopLoss: 48, riskReward: "1:1" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("2R") });
  });

  it("only places index scalps on the scalper", async () => {
    const response = await POST(requestFor({ action: "PLACE_ON_SCALPER", underlying: "RELIANCE", riskReward: "1:2" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ placed: false, error: expect.stringContaining("index options") });
  });

  it("never places on the scalper while the kill switch is on", async () => {
    process.env.ALGO_KILL_SWITCH = "true";
    try {
      const response = await POST(requestFor({ action: "PLACE_ON_SCALPER", underlying: "NIFTY", riskReward: "1:2" }));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ placed: false, error: expect.stringContaining("KILL_SWITCH_ACTIVE") });
    } finally { delete process.env.ALGO_KILL_SWITCH; }
  });
});
