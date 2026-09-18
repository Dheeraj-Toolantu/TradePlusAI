import { describe, expect, it } from "vitest";
import { formatConfidenceText, formatExpectedMoveText, formatMarketCalculationValue, getOptionChainEmptyState, getOrderExitState } from "../../apps/web/lib/option-chain-state";

describe("option chain state helpers", () => {
  it("formats missing confidence and expected move as clear safe labels", () => {
    expect(formatConfidenceText(undefined)).toBe("No confidence");
    expect(formatConfidenceText(63.2)).toBe("63/100");
    expect(formatExpectedMoveText(undefined)).toBe("No expected move");
    expect(formatExpectedMoveText(18.75)).toBe("18.75");
  });

  it("formats missing market-calculation values as explicit no-data labels", () => {
    expect(formatMarketCalculationValue(undefined)).toBe("—");
    expect(formatMarketCalculationValue(0)).toBe("0");
    expect(formatMarketCalculationValue(1.234, { percent: true })).toBe("1.23x");
    expect(formatMarketCalculationValue(1234.56, { currency: true })).toBe("₹1,234.56");
  });

  it("detects stop-loss and trailing-stop exits for hydrated Firebase orders", () => {
    const baseOrder = { price: 52, target: 72, stopLoss: 45, highWaterMark: 60, trailingDistance: 8, trailingActivatedAt: "2026-09-18T10:00:00Z" };
    expect(getOrderExitState(baseOrder, 39)).toMatchObject({ hitStop: true, exitReason: "AUTO_TRAILING_STOP" });
    expect(getOrderExitState({ price: 52, target: 72, stopLoss: 45 }, 38)).toMatchObject({ hitStop: true, exitReason: "AUTO_STOP_LOSS" });
    expect(getOrderExitState({ price: 52, target: 72, stopLoss: 45 }, 73)).toMatchObject({ hitTarget: true, exitReason: "AUTO_TARGET" });
  });

  it("returns a clean empty-state message for blocked or incomplete data", () => {
    expect(getOptionChainEmptyState("No actionable option candidates", "429 rate limited")).toMatchObject({
      title: "No actionable option candidates",
      detail: expect.stringContaining("Rate limited"),
    });

    expect(getOptionChainEmptyState("No actionable option candidates", "")).toMatchObject({
      title: "No actionable option candidates",
      detail: expect.stringMatching(/temporarily unavailable|incomplete/i),
    });
  });
});
