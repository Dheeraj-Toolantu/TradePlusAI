import { describe, expect, it } from "vitest";
import { precomputeSignals } from "../../services/backtest/src/optimizer";
import { smartSignalSource } from "../../services/backtest/src/smart-strategy";
import { smcSignalSource } from "../../services/backtest/src/smc-strategy";
import { runBacktest, type Signal } from "../../services/backtest/src/strategy-backtest";
import { syntheticSessions } from "../../services/backtest/src/synthetic-market";

const FROM = "2026-04-01";
const TO = "2026-09-30";

describe("smart combo strategy", () => {
  const { minute, daily } = syntheticSessions("2026-02-02", TO, { seed: 47, regimes: true });

  it("routes by regime: nothing against a trend day, range fades only from the extremes back to VWAP", () => {
    const smart = smartSignalSource("NIFTY", minute, daily);
    const result = runBacktest({ strategy: "SMART_COMBO", symbol: "NIFTY", from: FROM, to: TO, minute, signalAt: precomputeSignals(minute, smart, FROM, TO), settings: { trailR: 1.5, timeStopMinutes: 45 } });
    expect(result.trades.length).toBeGreaterThan(3);
    for (const trade of result.trades) {
      expect(trade.strategy).toMatch(/^Smart combo · /);
      const trendDay = trade.reason.match(/^\[trend day (↑|↓)/);
      if (trendDay) expect(trade.side).toBe(trendDay[1] === "↑" ? "LONG" : "SHORT");
      if (trade.reason.startsWith("[range day")) {
        expect(trade.strategy).toBe("Smart combo · liquidity sweep");
        expect(trade.reason).toMatch(/Range-day fade: T1 at VWAP/);
      }
    }
    expect(smart.funnel.regimeBars.TREND + smart.funnel.regimeBars.RANGE + smart.funnel.regimeBars.UNDECIDED).toBeGreaterThan(0);
  });

  it("filters out the chop trades that sink the sweep playbook on its own", () => {
    const settings = { trailR: 1.5, timeStopMinutes: 45 };
    const alone = runBacktest({ strategy: "SMC_SWEEP", symbol: "NIFTY", from: FROM, to: TO, minute, signalAt: precomputeSignals(minute, smcSignalSource("NIFTY", minute, daily), FROM, TO), settings });
    const smart = runBacktest({ strategy: "SMART_COMBO", symbol: "NIFTY", from: FROM, to: TO, minute, signalAt: precomputeSignals(minute, smartSignalSource("NIFTY", minute, daily), FROM, TO), settings });
    expect(smart.metrics.expectancyR).toBeGreaterThan(alone.metrics.expectancyR);
    expect(smart.metrics.netPnl).toBeGreaterThan(alone.metrics.netPnl);
  });

  it("blocks an ORB signal against a trend day and takes one with it", () => {
    // Pick a minute on a strong trend day (late morning) and feed an ORB signal each way there.
    const probe = smartSignalSource("NIFTY", minute, daily);
    let trendIndex = -1;
    let trendDir: 1 | -1 = 1;
    for (let index = 0; index < minute.length; index += 1) {
      const signal = probe(index);
      const match = signal?.reason.match(/^\[trend day (↑|↓)/);
      if (match) { trendIndex = index; trendDir = match[1] === "↑" ? 1 : -1; break; }
    }
    expect(trendIndex).toBeGreaterThan(0);
    const at = minute[trendIndex + 1].time + 60; // a different minute than the trend signal
    const orb = (side: 1 | -1): Signal => ({ time: at, side, stop: minute[trendIndex + 1].close - side * 20, target1: minute[trendIndex + 1].close + side * 40, target2: null, strategy: "ORB retest", reason: "ORB test" });
    const run = (side: 1 | -1) => { const source = smartSignalSource("NIFTY", minute, daily, { orbSignals: [orb(side)] }); let out: Signal | null = null; for (let k = 0; k <= trendIndex + 1; k += 1) out = source(k); return { out, funnel: source.funnel }; };
    const withTrend = run(trendDir);
    const against = run((-trendDir) as 1 | -1);
    expect(withTrend.out?.strategy).toBe("Smart combo · ORB retest");
    expect(against.out).toBeNull();
    expect(against.funnel.rejectedByRegime).toBeGreaterThan(withTrend.funnel.rejectedByRegime);
  });
});
