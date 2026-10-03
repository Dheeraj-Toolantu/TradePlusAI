import { describe, expect, it } from "vitest";
import { GET, POST } from "../../apps/web/app/api/backtest/route";

const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("backtest route", () => {
  it("lists strategies and defaults", async () => {
    const body = await (await GET()).json();
    expect(body.strategies.map((s: { id: string }) => s.id)).toEqual(["MTF_AI", "ORB_RETEST", "ORB_PRO", "SMC_SWEEP", "SMC_PLUS", "TREND_PULLBACK", "SMART_COMBO"]);
    expect(body.defaults).toMatchObject({ maxTradesPerDay: 3, squareOff: "15:15" });
  });

  it("validates the request", async () => {
    expect((await post({ strategy: "NOPE", symbol: "NIFTY", from: "2026-09-01", to: "2026-09-05" })).status).toBe(400);
    expect((await post({ strategy: "MTF_AI", symbol: "RELIANCE", from: "2026-09-01", to: "2026-09-05" })).status).toBe(400);
    const tooLong = await post({ strategy: "MTF_AI", symbol: "NIFTY", from: "2026-01-01", to: "2026-09-05" });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/at most 190/);
    const oldYahoo = await post({ strategy: "MTF_AI", symbol: "NIFTY", from: "2026-01-05", to: "2026-01-09", source: "yahoo" });
    expect(oldYahoo.status).toBe(400);
    expect((await oldYahoo.json()).error).toMatch(/Yahoo only keeps 1-minute candles/);
    expect((await post({ strategy: "MTF_AI", symbol: "NIFTY", from: "2026-09-05", to: "2026-09-01" })).status).toBe(400);
  });

  it.each(["MTF_AI", "ORB_RETEST", "SMC_SWEEP"])("runs %s on synthetic data and labels it as such", { timeout: 60_000 }, async (strategy) => {
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
    // Candles for the chart cover only the tested sessions (no warm-up days) as compact rows.
    expect(body.candles).toHaveLength(5 * 375);
    expect(body.candles[0]).toHaveLength(6);
    const firstIst = new Date((body.candles[0][0] + 19_800) * 1000).toISOString();
    expect(firstIst.slice(0, 16)).toBe("2026-09-21T09:15");
  });

  it("runs the SMC strategy over six months and reports its setup funnel", { timeout: 60_000 }, async () => {
    const response = await post({ strategy: "SMC_SWEEP", symbol: "BANKNIFTY", from: "2026-03-23", to: "2026-09-25", source: "synthetic" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions).toBeGreaterThan(120);
    expect(body.candleMinutes).toBe(5);
    expect(body.candles.length).toBe(body.sessions * 75);
    expect(body.notes.join(" ")).toMatch(/Setup funnel: \d+ liquidity sweeps/);
    for (const trade of body.trades) expect(trade.strategy).toBe("SMC liquidity sweep");
    // 1-minute candles ship for every trade day so the replay prints minute by minute.
    expect(Object.keys(body.replayMinutes).sort()).toEqual([...new Set(body.trades.map((trade: { day: string }) => trade.day))].sort());
    for (const rows of Object.values(body.replayMinutes) as unknown[][]) expect(rows).toHaveLength(375);
  });

  it("runs the trend-day strategy with the walk-forward optimizer", { timeout: 120_000 }, async () => {
    const response = await post({ strategy: "TREND_PULLBACK", symbol: "NIFTY", from: "2026-04-06", to: "2026-09-25", source: "synthetic", settings: { trailR: 1 }, optimize: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings.trailR).toBe(1);
    expect(body.notes.join(" ")).toMatch(/Setup funnel: \d+ 5m closes checked/);
    expect(body.optimization.tested).toBe(648);
    expect(body.optimization.inSample.to < body.optimization.outOfSample.from).toBe(true);
    expect(body.optimization.baseline.inSample.trades + body.optimization.baseline.outOfSample.trades).toBe(body.metrics.trades);
  });

  it("runs the smart combo with all four playbooks (ORB via Python) and explains its routing", { timeout: 180_000 }, async () => {
    process.env.PYTHON_EXECUTABLE ??= "python3";
    const response = await post({ strategy: "SMART_COMBO", symbol: "NIFTY", from: "2026-07-01", to: "2026-09-25", source: "synthetic", settings: { trailR: 1.5, timeStopMinutes: 45 } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const notes = body.notes.join(" ");
    expect(notes).toMatch(/Regime: \d+% of minutes on trend days/);
    expect(notes).toMatch(/Playbook signals: trend \d+, sweep \d+, ORB \d+/);
    expect(notes).not.toMatch(/ORB playbook skipped/);
    for (const trade of body.trades) expect(trade.strategy).toMatch(/^Smart combo · /);
  });

  it("runs ORB retest Pro, reports its funnel and ships each trade's stop path", { timeout: 120_000 }, async () => {
    const response = await post({ strategy: "ORB_PRO", symbol: "NIFTY", from: "2026-04-06", to: "2026-09-25", source: "synthetic", settings: { trailR: 1, timeStopMinutes: 30 } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notes.join(" ")).toMatch(/Setup funnel: \d+ sessions \(\d+ gap days/);
    for (const trade of body.trades) {
      expect(trade.strategy).toBe("ORB retest Pro");
      expect(Array.isArray(trade.stopPath)).toBe(true);
      expect(trade.reason).toMatch(/SL [\d,.]+ \([\d.]+ pts\)/);
    }
  });
});
