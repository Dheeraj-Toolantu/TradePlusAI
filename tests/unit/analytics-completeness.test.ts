import { describe, expect, it } from "vitest";
import { aggregatePerformance } from "../../services/audit/src/analytics-service";

describe("analytics completeness", () => {
  it("reports risk-aware and cost-aware metrics", () => {
    const report = aggregatePerformance([2, -1, 3], "PAPER", { rMultiples: [2, -1, 3], costs: 10, slippage: 4, exposure: 500, regimes: ["BULL", "BEAR", "BULL"] });
    expect(report.profitFactor).toBe(5);
    expect(report.averageR).toBeCloseTo(4 / 3);
    expect(report.medianR).toBe(2);
    expect(report.costs).toBe(10);
    expect(report.slippage).toBe(4);
    expect(report.exposure).toBe(500);
    expect(report.regimeBreakdown.BULL.trades).toBe(2);
  });
});
