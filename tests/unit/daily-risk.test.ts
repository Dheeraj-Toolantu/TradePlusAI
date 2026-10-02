import { describe, expect, it } from "vitest";
import { evaluateDailyRisk } from "../../apps/web/lib/daily-risk";
import type { OrderRecord } from "../../apps/web/lib/firestore-orders";

const NOW = new Date("2026-09-29T05:00:00Z"); // 10:30 IST
const order = (overrides: Partial<OrderRecord>): OrderRecord => ({ id: Math.random().toString(36), symbol: "NIFTY26OCT24500CE", side: "BUY", quantity: 65, price: 100, status: "EXITED", mode: "PAPER", underlying: "NIFTY", createdAt: "2026-09-29T04:00:00Z", ...overrides });

describe("V5 daily risk manager", () => {
  it("allows a clean day and explains the budget", () => {
    const state = evaluateDailyRisk([], "NIFTY", 100_000, NOW);
    expect(state.allowed).toBe(true);
    expect(state.detail).toContain("0/3 trades");
  });

  it("starts a 15-minute cooldown after a loss", () => {
    const state = evaluateDailyRisk([order({ realizedPnl: -500, exitAt: "2026-09-29T04:50:00Z" })], "NIFTY", 100_000, NOW);
    expect(state.allowed).toBe(false);
    expect(state.detail).toContain("cooling down");
    expect(evaluateDailyRisk([order({ realizedPnl: -500, exitAt: "2026-09-29T04:40:00Z" })], "NIFTY", 100_000, NOW).allowed).toBe(true);
  });

  it("stops entries for the day after two consecutive losses", () => {
    const state = evaluateDailyRisk([
      order({ realizedPnl: -300, exitAt: "2026-09-29T04:10:00Z" }),
      order({ realizedPnl: -300, exitAt: "2026-09-29T04:20:00Z" }),
    ], "NIFTY", 100_000, NOW);
    expect(state.consecutiveLosses).toBe(2);
    expect(state.detail).toContain("consecutive losses");
  });

  it("a win resets the consecutive-loss count", () => {
    const state = evaluateDailyRisk([
      order({ realizedPnl: -300, exitAt: "2026-09-29T04:10:00Z" }),
      order({ realizedPnl: 800, exitAt: "2026-09-29T04:20:00Z" }),
    ], "NIFTY", 100_000, NOW);
    expect(state.consecutiveLosses).toBe(0);
    expect(state.allowed).toBe(true);
  });

  it("blocks at the daily loss limit, the trade cap and while a position is open", () => {
    expect(evaluateDailyRisk([order({ realizedPnl: -2_000, exitAt: "2026-09-29T03:50:00Z" })], "NIFTY", 100_000, NOW).detail).toContain("limit");
    expect(evaluateDailyRisk([order({ realizedPnl: 10 }), order({ realizedPnl: 10 }), order({ realizedPnl: 10 })], "NIFTY", 100_000, NOW).detail).toContain("3/3 trades already");
    expect(evaluateDailyRisk([order({ status: "OPEN" })], "NIFTY", 100_000, NOW).detail).toContain("already open");
    // A BANKNIFTY position does not block NIFTY.
    expect(evaluateDailyRisk([order({ status: "OPEN", underlying: "BANKNIFTY", symbol: "BANKNIFTY26OCT52000CE" })], "NIFTY", 100_000, NOW).allowed).toBe(true);
  });

  it("ignores yesterday's trades and live positions", () => {
    const state = evaluateDailyRisk([
      order({ realizedPnl: -5_000, createdAt: "2026-09-28T04:00:00Z", exitAt: "2026-09-28T05:00:00Z" }),
      order({ mode: "ALGO_LIVE", status: "OPEN" }),
    ], "NIFTY", 100_000, NOW);
    expect(state.allowed).toBe(true);
  });
});

describe("daily risk with open positions", () => {
  it("counts the open position's mark-to-market loss toward the daily loss limit", () => {
    const state = evaluateDailyRisk([
      order({ realizedPnl: -1_200, exitAt: "2026-09-29T04:10:00Z", underlying: "BANKNIFTY", symbol: "BANKNIFTY26OCT52000CE" }),
      order({ status: "OPEN", underlying: "SENSEX", symbol: "SENSEX26OCT82000CE", pnl: -900 }),
    ], "NIFTY", 100_000, new Date("2026-09-29T05:30:00Z"));
    expect(state.openLoss).toBe(-900);
    expect(state.allowed).toBe(false);
    expect(state.detail).toContain("incl. ₹-900 open");
  });
  it("ignores open profits", () => {
    const state = evaluateDailyRisk([order({ status: "OPEN", underlying: "SENSEX", symbol: "SENSEX26OCT82000CE", pnl: 4_000 })], "NIFTY", 100_000, NOW);
    expect(state.openLoss).toBe(0);
  });
});
