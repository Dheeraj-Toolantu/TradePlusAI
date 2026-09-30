import { describe, expect, it } from "vitest";
import { buildTechnicalPlan, type Candle } from "../../apps/web/lib/technical-plan";

function candlesFromClose(values: number[]): Candle[] {
  return values.map((close, index) => {
    const open = index === 0 ? close : values[index - 1];
    const previous = values[index - 1] ?? close;
    return {
      open,
      high: Math.max(open, close) + 1.5,
      low: Math.min(open, close) - 1.5,
      close,
      volume: 1000 + index * 50,
      timestamp: new Date(2024, 0, 1, 9, index).toISOString(),
    };
  });
}

describe("technical plan recalculation", () => {
  it("changes the plan when the selected market data window changes", () => {
    const bullish = buildTechnicalPlan(candlesFromClose(Array.from({ length: 35 }, (_, index) => 100 + index * 0.8)), {
      support: 100,
      resistance: 130,
      supportStrike: 100,
      resistanceStrike: 130,
      source: "demo",
    });

    const bearish = buildTechnicalPlan(candlesFromClose(Array.from({ length: 35 }, (_, index) => 130 - index * 0.8)), {
      support: 100,
      resistance: 130,
      supportStrike: 100,
      resistanceStrike: 130,
      source: "demo",
    });

    expect(bullish).not.toBeNull();
    expect(bearish).not.toBeNull();
    expect(bullish?.side).not.toBe(bearish?.side);
    expect(Math.abs((bullish?.entry ?? 0) - (bearish?.entry ?? 0))).toBeGreaterThan(0);
  });

  it("calculates an auto-drawn risk reward ratio from the trade plan", () => {
    const plan = buildTechnicalPlan(candlesFromClose(Array.from({ length: 30 }, (_, index) => 100 + index * 1.1)), {
      support: 96,
      resistance: 120,
      supportStrike: 96,
      resistanceStrike: 120,
      source: "demo",
    });

    expect(plan).not.toBeNull();
    expect(plan?.riskReward).toBeGreaterThan(1);
    expect(plan?.riskRewardLabel).toContain("1:");
  });
});
