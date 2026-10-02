import { describe, expect, it } from "vitest";
import { GET, POST } from "../../apps/web/app/api/backtest/route";

const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("backtest route", () => {
  it("lists strategies and defaults", async () => {
    const body = await (await GET()).json();
    expect(body.strategies.map((s: { id: string }) => s.id)).toEqual(["MTF_AI", "ORB_RETEST"]);
    expect(body.defaults).toMatchObject({ maxTradesPerDay: 3, squareOff: "15:15" });
  });

  it("validates the request", async () => {
    expect((await post({ strategy: "NOPE", symbol: "NIFTY", from: "2026-09-01", to: "2026-09-05" })).status).toBe(400);
    expect((await post({ strategy: "MTF_AI", symbol: "RELIANCE", from: "2026-09-01", to: "2026-09-05" })).status).toBe(400);
    const tooLong = await post({ strategy: "MTF_AI", symbol: "NIFTY", from: "2026-06-01", to: "2026-09-05" });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/at most 31/);
    expect((await post({ strategy: "MTF_AI", symbol: "NIFTY", from: "2026-09-05", to: "2026-09-01" })).status).toBe(400);
  });

  it.each(["MTF_AI", "ORB_RETEST"])("runs %s on synthetic data and labels it as such", { timeout: 60_000 }, async (strategy) => {
    process.env.PYTHON_EXECUTABLE ??= "python3";
    const response = await post({ strategy, symbol: "NIFTY", from: "2026-09-21", to: "2026-09-25", source: "synthetic", settings: { lots: 2, maxTradesPerDay: 2 } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions).toBe(5);
    expect(body.notes[0]).toMatch(/SYNTHETIC DEMO DATA/);
    expect(body.settings).toMatchObject({ lots: 2, maxTradesPerDay: 2 });
    expect(body.daily).toHaveLength(5);
    expect(body.trades.length).toBeLessThanOrEqual(10);
    expect(body.metrics.trades).toBe(body.trades.length);
  });
});
