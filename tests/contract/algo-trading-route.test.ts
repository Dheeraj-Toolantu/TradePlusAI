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

  it("stores the intrinsic-value premium trail on a manual paper order", async () => {
    const response = await POST(requestFor({
      mode: "PAPER", orderSource: "MANUAL", strategy: "INTRINSIC_VALUE", strategyName: "Intrinsic Value OTM", underlying: "NIFTY",
      symbol: "NIFTY2691523300PE", growwSymbol: "NIFTY2691523300PE", side: "BUY", quantity: 65, price: 52.5, target: 76.25, stopLoss: 48, trailingDistance: 4.5,
      lotSize: 65, expiry: "2026-09-15", optionType: "PE", strike: 23300, tickSize: 0.05, freezeQuantity: 1801, contractActive: true, sentimentMapping: "CONTRARIAN",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ order: expect.objectContaining({ strategy: "INTRINSIC_VALUE", trailingDistance: 4.5, initialStopLoss: 48, highWaterMark: 52.5 }) });
  });
});
