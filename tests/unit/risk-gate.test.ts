import { describe, expect, it } from "vitest";
import { evaluateRisk } from "../../services/risk/src/risk-gate";

const input = { signalId: "s1", mode: "PAPER" as const, capital: 100000, riskPercent: 1, entry: 190, stop: 165, target: 240, candidateQuantity: 40, lotSize: 5, dailyLoss: 0, maxDailyLoss: 3000, openPositions: 0, maxOpenPositions: 2, tradesToday: 0, maxTradesToday: 5, minRiskReward: 2, marketFreshness: "FRESH" as const, killSwitch: false };

describe("risk gate", () => {
  it("allows a valid lot-sized trade", () => { const result = evaluateRisk(input); expect(result.decision).toBe("ALLOW"); expect(result.normalizedQuantity).toBe(40); });
  it("blocks a trade below minimum R:R", () => { const result = evaluateRisk({ ...input, target: 200 }); expect(result.decision).toBe("BLOCK"); expect(result.checks.find((check) => check.name === "minimum_rr")?.result).toBe(false); });
  it("fails closed for stale data and kill switch", () => { expect(evaluateRisk({ ...input, marketFreshness: "STALE" }).decision).toBe("BLOCK"); expect(evaluateRisk({ ...input, killSwitch: true }).decision).toBe("BLOCK"); });
});