import { describe, expect, it } from "vitest";
import { evaluateAutoTrade, DEFAULT_AUTOTRADE_LIMITS, autoTradeLimitsFromEnv, type AutoTradeContext } from "../../services/ai-monitoring/src/ai-autotrade-policy";
import { adviceFromModel, deterministicAdvice, type OptionAdvice } from "../../services/ai-monitoring/src/option-advisor";
import { analyzeMultiTimeframe } from "../../services/ai-monitoring/src/mtf-decision-engine";
import { AutoOptionTrader } from "../../services/paper-trading/src/auto-option-trader";
import { bullishStack, MTF_NOW } from "../fixtures/mtf-candles";

const advice = (overrides: Partial<OptionAdvice> = {}): OptionAdvice => ({
  source: "AI", symbol: "NIFTY", expiry: "2026-10-06", lotSize: 65, action: "BUY_CE", confidence: 78, headline: "Buy CE on 15m pullback", strategy: "MTF pullback",
  marketRead: "", psychology: [], reasons: [], risks: [], notes: [], blockedBy: [], generatedAt: MTF_NOW.toISOString(), trigger: "", invalidation: "",
  contract: { side: "CE", trading_symbol: "NIFTY26O0624500CE", strike: 24500, premium: 120, delta: 0.55, liquidity_score: 3 },
  spot: { entryLow: 24525, entryHigh: 24530, stop: 24500, target1: 24590, target2: 24620 },
  premium: { entry: 120, stop: 103.5, target1: 153, target2: 170, riskReward: 2 },
  mtf: { action: "BUY_CE", confidence: 74, alignment: "BULLISH_ALIGNED", headline: "", timeframes: [], valuation: [], keyLevels: [] },
  ...overrides,
});
const context = (overrides: Partial<AutoTradeContext> = {}): AutoTradeContext => ({
  symbol: "NIFTY", advice: advice(), adviceAgeMs: 10_000, adviceSpot: 24530, liveSpot: 24532, livePremium: 121, confidenceThreshold: 70,
  risk: { tradeDate: "2026-09-30", tradesToday: 0, openPositions: 0, realizedPnlToday: 0, consecutiveLosses: 0, lastLossExitAt: null },
  limits: DEFAULT_AUTOTRADE_LIMITS, killSwitch: false, safeMode: false, now: MTF_NOW, ...overrides,
});

describe("AI auto-trade policy", () => {
  it("turns a fresh, aligned, confident suggestion into a signal with the AI's premium levels", () => {
    const verdict = evaluateAutoTrade(context());
    expect(verdict.allowed).toBe(true);
    expect(verdict.signal).toMatchObject({ side: "BUY", stopLoss: 24500, target: 24590, preferredSymbol: "NIFTY26O0624500CE", premium: { stop: 103.5, target: 153 }, lots: 1 });
  });
  it.each([
    ["WAIT advice", { advice: advice({ action: "WAIT", contract: null, spot: null, premium: null }) }, /WAIT/],
    ["low confidence", { confidenceThreshold: 80 }, /below the 80%/],
    ["stale advice", { adviceAgeMs: 120_000 }, /stale/],
    ["misaligned timeframes", { advice: advice({ mtf: { action: "WAIT", confidence: 0, alignment: "MIXED", headline: "", timeframes: [], valuation: [], keyLevels: [] } }) }, /mixed/],
    ["chasing spot", { liveSpot: 24550 }, /not chasing/],
    ["chasing premium", { livePremium: 140 }, /above the planned entry/],
    ["open position", { risk: { tradeDate: "", tradesToday: 1, openPositions: 1, realizedPnlToday: 0, consecutiveLosses: 0, lastLossExitAt: null } }, /already open/],
    ["daily loss limit", { risk: { tradeDate: "", tradesToday: 2, openPositions: 0, realizedPnlToday: -3200, consecutiveLosses: 1, lastLossExitAt: null } }, /Daily loss limit/],
    ["consecutive losses", { risk: { tradeDate: "", tradesToday: 2, openPositions: 0, realizedPnlToday: -900, consecutiveLosses: 2, lastLossExitAt: null } }, /losses in a row/],
    ["cooldown", { risk: { tradeDate: "", tradesToday: 1, openPositions: 0, realizedPnlToday: -400, consecutiveLosses: 1, lastLossExitAt: new Date(MTF_NOW.getTime() - 5 * 60_000).toISOString() } }, /Cooling down/],
    ["kill switch", { killSwitch: true }, /Kill switch/],
  ])("blocks on %s", (_name, overrides, pattern) => {
    const verdict = evaluateAutoTrade(context(overrides as Partial<AutoTradeContext>));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(pattern);
  });
  it("reads limits from the environment with safe bounds", () => {
    expect(autoTradeLimitsFromEnv({ AI_AUTOTRADE_LOTS: "2", AI_AUTOTRADE_MAX_TRADES: "999" })).toMatchObject({ lots: 2, maxTradesPerDay: DEFAULT_AUTOTRADE_LIMITS.maxTradesPerDay });
  });
});

describe("AI paper trader", () => {
  const contract = (premium: number) => ({ symbol: "NIFTY26O0624500CE", contract: "CALL" as const, expiry: "2026-10-06", strike: 24500, premium, bid: premium - 0.5, ask: premium + 0.5, openInterest: 1e6, volume: 1e5, iv: 13, delta: 0.55, score: 80, riskReward: 2, lotSize: 65, tickSize: 0.05, freezeQuantity: 1800 });
  const signal = evaluateAutoTrade(context()).signal!;

  it("fills with slippage, keeps the planned stop/target, and squares off at 15:15 IST", async () => {
    let now = new Date("2026-09-30T05:30:00Z"); // 11:00 IST
    const trader = new AutoOptionTrader({ strategyId: "AI_MONITOR", idPrefix: "ai", minScore: 0, trendEntries: false, slippagePct: 0.005, squareOffIst: "15:15", now: () => now });
    const opened = await trader.tick({ symbol: "NIFTY", spot: 24530, candles: [], contracts: [contract(120)], strategySignal: signal });
    const order = opened.orders.at(-1)!;
    expect(order.strategy).toBe("AI_MONITOR");
    expect(order.price).toBe(120.6);
    expect(order.stopLoss).toBe(103.5);
    expect(order.target).toBe(153);
    expect(trader.riskSnapshot()).toMatchObject({ openPositions: 1, tradesToday: 1 });
    now = new Date("2026-09-30T09:46:00Z"); // 15:16 IST
    await trader.tick({ symbol: "NIFTY", spot: 24540, candles: [], contracts: [contract(126)] });
    const exited = trader.listOrders().at(-1)!;
    expect(exited.status).toBe("EXITED");
    expect(exited.exitReason).toBe("AUTO_SQUARE_OFF");
    expect(exited.exitPrice).toBe(125.35);
    expect(trader.riskSnapshot().openPositions).toBe(0);
  });

  it("tracks realised losses and consecutive losses for the daily risk limits", async () => {
    const now = new Date("2026-09-30T05:30:00Z");
    const trader = new AutoOptionTrader({ strategyId: "AI_MONITOR", minScore: 0, trendEntries: false, now: () => now });
    await trader.tick({ symbol: "NIFTY", spot: 24530, candles: [], contracts: [contract(120)], strategySignal: signal });
    await trader.tick({ symbol: "NIFTY", spot: 24495, candles: [], contracts: [contract(100)] });
    const risk = trader.riskSnapshot();
    expect(risk.realizedPnlToday).toBe(-1300);
    expect(risk.consecutiveLosses).toBe(1);
    expect(risk.lastLossExitAt).toBe(now.toISOString());
  });
});

describe("advisor uses the multi-timeframe engine", () => {
  const baseIntel = (mtf: unknown) => ({
    symbol: "NIFTY", available: true, spot: 24530, expiry: "2026-10-06", lot_size: 65, generated_at: "2026-09-30T10:20:00+05:30",
    session: { market_open: true, entry_permitted: true }, technicals: { atr14: 20 }, volatility: { regime: "NORMAL" },
    contract_candidates: { CE: { strike: 24500, premium: 120, delta: 0.55, trading_symbol: "CE1", liquidity_score: 3 }, PE: { strike: 24550, premium: 110, delta: -0.5, trading_symbol: "PE1", liquidity_score: 3 } },
    mtf_decision: mtf,
  });
  const bearish = analyzeMultiTimeframe({ symbol: "NIFTY", spot: bullishStack(-1).spot, candles: bullishStack(-1), now: MTF_NOW });
  const reply = JSON.stringify({ action: "BUY_CE", confidence: 80, entry_zone_low: 24520, entry_zone_high: 24530, stop: 24500, target1: 24600, target2: 24640 });

  it("forces WAIT when the model buys against the aligned timeframes", () => {
    expect(bearish.alignment).toBe("BEARISH_ALIGNED");
    const result = adviceFromModel(baseIntel(bearish), reply, "test")!;
    expect(result.action).toBe("WAIT");
    expect(result.notes.join(" ")).toMatch(/against the aligned bearish/);
    expect(result.mtf?.alignment).toBe("BEARISH_ALIGNED");
  });

  it("reports honest premium reward/risk and rejects trades below 1.5R", () => {
    const thin = JSON.stringify({ action: "BUY_CE", confidence: 80, entry_zone_low: 24525, entry_zone_high: 24530, stop: 24500, target1: 24576, target2: null });
    const result = adviceFromModel(baseIntel(null), thin, "test")!;
    // 30-pt risk x 0.55 = 16.5 premium; 46-pt reward x 0.55 = 25.3 -> 1.53R honest (was padded to 2R before)
    expect(result.action).toBe("BUY_CE");
    expect(result.premium!.riskReward).toBeCloseTo(1.53, 1);
    // A deep premium: the 10% premium stop floor (₹40) dwarfs the 16.5 delta-mapped risk, so the
    // honest reward/risk collapses to ~0.6R and the trade is refused instead of padded to 2R.
    const deep = { ...baseIntel(null), contract_candidates: { CE: { strike: 24100, premium: 400, delta: 0.55, trading_symbol: "CE1", liquidity_score: 3 }, PE: null } };
    const tooThin = adviceFromModel(deep, thin, "test")!;
    expect(tooThin.action).toBe("WAIT");
    expect(tooThin.notes.join(" ")).toMatch(/reward\/risk is only/);
  });

  it("uses the multi-timeframe plan as the rule-based fallback", () => {
    const stack = bullishStack(1);
    const decision = analyzeMultiTimeframe({ symbol: "NIFTY", spot: stack.spot, candles: stack, now: MTF_NOW, candidates: { CE: { side: "CE", trading_symbol: "CE1", strike: Math.round(stack.spot / 50) * 50, premium: 20, delta: 0.55 } } });
    // Synthetic 5m ATR is ~5 pts, so a ₹20 premium keeps the 10% premium stop floor from binding.
    const intel = { ...baseIntel(decision), spot: stack.spot, contract_candidates: { CE: { strike: Math.round(stack.spot / 50) * 50, premium: 20, delta: 0.55, trading_symbol: "CE1", liquidity_score: 3 } } };
    const result = deterministicAdvice(intel);
    expect(decision.action).toBe("BUY_CE");
    expect(result.action).toBe("BUY_CE");
    expect(result.strategy).toMatch(/Multi-timeframe/);
    expect(result.exitPlan?.join(" ")).toMatch(/15:15/);
  });
});
