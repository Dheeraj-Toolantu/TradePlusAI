import { describe, expect, it } from "vitest";
import { adviceFromModel, buildAdvisorBrief, buildAdvisorMessages, deterministicAdvice } from "../../services/ai-monitoring/src/option-advisor";

const intel = (overrides: Record<string, unknown> = {}) => ({
  symbol: "NIFTY", available: true, spot: 24530, expiry: "2026-10-06", expiry_today: false, lot_size: 65, generated_at: "2026-09-30T10:20:00+05:30",
  session: { market_open: true, entry_permitted: true, window: "ENTRY_WINDOW" },
  technicals: { last_price: 24530, vwap: 24510, ema20: 24505, ema50: 24480, rsi14: 58, atr14: 20, trend_15m: "BULLISH" },
  verdict: { bias: "BULLISH", score: 5.5, factors: [{ name: "Price vs VWAP", points: 1.5, detail: "above" }] },
  smart_money: { trend: "BULLISH", order_blocks: [{ direction: "BULLISH", top: 24500, bottom: 24480 }], fair_value_gaps: [] },
  options_flow: { pcr_oi: 1.1, max_pain: 24500, support: [{ strike: 24500 }], resistance: [{ strike: 24700 }], oi_direction_label: "Bullish" },
  volatility: { value: 13, regime: "NORMAL", expected_range: { low: 24300, high: 24760 } },
  smart_entry: { status: "ENTRY", side: "CE", headline: "BUY CE (bullish reversal from demand): score 9.0/10", score: 9, spot: { entry: 24530, stop: 24468, target1: 24654, target2: 24700 }, trigger: { level: 24522, time: "10:18" }, psychology: ["Late sellers trapped below 24480"], factors: [] },
  trade_plan: { status: "WAIT", direction: "CE" },
  contract_candidates: { CE: { strike: 24500, premium: 120, delta: 0.55, trading_symbol: "NIFTY26O0624500CE", liquidity_score: 3 }, PE: { strike: 24550, premium: 110, delta: -0.5, trading_symbol: "NIFTY26O0624550PE", liquidity_score: 3 } },
  ...overrides,
});
const reply = (fields: Record<string, unknown>) => JSON.stringify({ action: "BUY_CE", confidence: 72, strategy: "Demand-zone reversal", headline: "Buy the reclaim of 24,500", market_read: "Buyers defended the put wall.", psychology: ["Shorts trapped under 24,480"], reasons: ["1m CHoCH"], risks: ["Call wall 24,700"], entry_zone_low: 24520, entry_zone_high: 24535, stop: 24468, target1: 24654, target2: 24700, trigger: "Hold above 24,522", invalidation: "5m close below 24,468", ...fields });

describe("AI option advisor", () => {
  it("builds a compact brief with real contract candidates and no raw chain", () => {
    const brief = buildAdvisorBrief(intel());
    expect(JSON.stringify(brief).length).toBeLessThan(9_500);
    expect((brief.candidates as Record<string, { trading_symbol: string }>).CE.trading_symbol).toBe("NIFTY26O0624500CE");
    expect(buildAdvisorMessages(intel())[0].content).toContain("BUY_CE|BUY_PE|WAIT");
  });

  it("accepts a valid call suggestion and prices the option from spot levels via delta", () => {
    const advice = adviceFromModel(intel(), `Here you go:\n\`\`\`json\n${reply({})}\n\`\`\``, "gpt-oss-20b")!;
    expect(advice.action).toBe("BUY_CE");
    expect(advice.contract?.trading_symbol).toBe("NIFTY26O0624500CE");
    // 62-pt spot risk x 0.55 delta = 34.1 premium; 124-pt reward x 0.55 = 68.2.
    expect(advice.premium?.stop).toBeCloseTo(85.9, 1);
    expect(advice.premium?.target1).toBeCloseTo(188.2, 1);
    expect(advice.premium?.riskReward).toBeGreaterThanOrEqual(2);
  });

  it("forces WAIT when a hard gate is active, whatever the model says", () => {
    const advice = adviceFromModel(intel({ volatility: { value: 32, regime: "EXTREME" } }), reply({}))!;
    expect(advice.action).toBe("WAIT");
    expect(advice.contract).toBeNull();
    expect(advice.blockedBy.join(" ")).toContain("EXTREME");
  });

  it("treats low confidence as WAIT", () => {
    expect(adviceFromModel(intel(), reply({ confidence: 0.3 }))!.action).toBe("WAIT");
  });

  it("replaces levels on the wrong side of price with the engine's structure", () => {
    const advice = adviceFromModel(intel(), reply({ stop: 24600, target1: 24400 }))!;
    expect(advice.spot?.stop).toBe(24468);
    expect(advice.notes.join(" ")).toContain("structural");
  });

  it("rewrites promises of certainty", () => {
    expect(adviceFromModel(intel(), reply({ headline: "Guaranteed profit, risk-free CE" }))!.headline).not.toMatch(/guarantee|risk-free/i);
  });

  it("rejects non-JSON replies so the caller can fall back", () => {
    expect(adviceFromModel(intel(), "I think the market will go up.")).toBeNull();
  });

  it("falls back to the smart zone entry when the model is unavailable", () => {
    const advice = deterministicAdvice(intel(), "AI model unavailable");
    expect(advice.source).toBe("DETERMINISTIC");
    expect(advice.action).toBe("BUY_CE");
    expect(advice.confidence).toBe(90);
  });

  it("falls back to WAIT when nothing is confirmed", () => {
    const advice = deterministicAdvice(intel({ smart_entry: { status: "ARMED", reason: "Price is testing the demand zone" } }));
    expect(advice.action).toBe("WAIT");
    expect(advice.trigger).toContain("demand zone");
  });
});
