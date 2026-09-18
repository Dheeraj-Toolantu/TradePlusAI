import { describe, expect, it } from "vitest";
import { validateTradeSetup } from "../../services/options-analytics/src/trade-setup-validator";

describe("trade setup validator", () => {
  it("waits for a breakout when price is directly below resistance", () => {
    const result = validateTradeSetup({
      side: "LONG",
      currentPrice: 23567.85,
      resistance: 23571.05,
      fiveMinuteClose: 23567.85,
      swingLow: 23470.85,
      nextResistance: 23602.83,
      minRiskReward: 2,
    });

    expect(result.status).toBe("WAIT_FOR_BREAKOUT");
    expect(result.actionable).toBe(false);
    expect(result.reason).toContain("5-minute close");
  });

  it("accepts a confirmed breakout only when structural geometry meets minimum R:R", () => {
    const result = validateTradeSetup({
      side: "LONG",
      currentPrice: 23600,
      resistance: 23571.05,
      fiveMinuteClose: 23600,
      swingLow: 23585,
      nextResistance: 23640,
      stopBuffer: 2,
      minRiskReward: 2,
    });

    expect(result.status).toBe("LONG");
    expect(result.actionable).toBe(true);
    expect(result.stop).toBe(23583);
    expect(result.target).toBe(23640);
    expect(result.riskReward).toBeCloseTo(40 / 17, 5);
    expect(result.confirmation).toBe("BREAKOUT_CLOSE");
  });

  it("accepts a bullish breakout-retest hold with a structural retest stop", () => {
    const result = validateTradeSetup({
      side: "LONG",
      currentPrice: 23580,
      resistance: 23571,
      fiveMinuteClose: 23580,
      breakoutClose: 23578,
      retestHeld: true,
      bullishConfirmation: true,
      swingLow: 23560,
      retestSupport: 23572,
      nextResistance: 23620,
      stopBuffer: 1,
      minRiskReward: 2,
    });

    expect(result.status).toBe("LONG");
    expect(result.confirmation).toBe("BREAKOUT_RETEST");
    expect(result.stop).toBe(23571);
  });

  it("rejects a long after resistance rejection", () => {
    const result = validateTradeSetup({
      side: "LONG",
      currentPrice: 23568,
      resistance: 23571,
      fiveMinuteClose: 23568,
      rejection: true,
      minRiskReward: 2,
    });

    expect(result.status).toBe("NO_LONG");
    expect(result.actionable).toBe(false);
  });

  it("blocks a confirmed setup when reward to risk is below the minimum", () => {
    const result = validateTradeSetup({
      side: "LONG",
      currentPrice: 23600,
      resistance: 23571,
      fiveMinuteClose: 23600,
      swingLow: 23500,
      nextResistance: 23635,
      minRiskReward: 2,
    });

    expect(result.status).toBe("BLOCKED_RR");
    expect(result.actionable).toBe(false);
    expect(result.riskReward).toBeCloseTo(35 / 100, 5);
  });
});
