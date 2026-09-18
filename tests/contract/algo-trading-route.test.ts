import { describe, expect, it } from "vitest";
import { POST } from "../../apps/web/app/api/algo-trading/route";

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
  });
});
