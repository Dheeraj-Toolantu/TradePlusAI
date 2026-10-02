import { NextResponse } from "next/server";
import { getMonitoringService } from "../../../../../../services/ai-monitoring/src/monitoring-service";
import { autoTradeLimitsFromEnv, evaluateAutoTrade } from "../../../../../../services/ai-monitoring/src/ai-autotrade-policy";
import { readSafeModeState } from "../../../../../../services/execution/src/safe-mode";
import { AutoOptionTrader } from "../../../../../../services/paper-trading/src/auto-option-trader";
import { cachedAdvice, getAdvice } from "../../../../lib/ai-advice";
import { isIntelSymbol } from "../../../../lib/market-intel";

/**
 * AI auto-trade (PAPER). When the trader switches on "Auto-trade" in the AI monitoring panel, the
 * panel calls POST every 15 s. Each tick:
 *   1. manages open AI positions first: target, stop, trailing stop, max loss, 15:15 square-off,
 *      with slippage applied to fills. This runs even when the kill switch is on;
 *   2. then, only if every gate in ai-autotrade-policy passes, enters the AI's suggested contract
 *      with the AI's structural stop/target.
 * Live (ALGO_LIVE) orders are never placed here: they go through the PIN-confirmed live flow.
 */
const traderGlobal = globalThis as typeof globalThis & { __tradepulseAiTrader?: AutoOptionTrader };
function aiTrader() {
  traderGlobal.__tradepulseAiTrader ??= new AutoOptionTrader({
    strategyId: "AI_MONITOR",
    idPrefix: "ai",
    maxTrades: autoTradeLimitsFromEnv().maxTradesPerDay,
    minScore: 0,
    minRiskReward: 1.5,
    trendEntries: false,
    slippagePct: Number(process.env.AI_AUTOTRADE_SLIPPAGE_PCT ?? 0.5) / 100,
    squareOffIst: "15:15",
  });
  return traderGlobal.__tradepulseAiTrader;
}

type Raw = Record<string, unknown>;
const num = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };

async function chainContracts(origin: string, symbol: string) {
  const response = await fetch(`${origin}/api/option-chain?symbol=${encodeURIComponent(symbol)}&full=1`, { cache: "no-store" });
  const body = await response.json() as { contracts?: Raw[]; spot?: number; error?: string };
  if (!response.ok || !Array.isArray(body.contracts)) throw new Error(body.error ?? "Option chain unavailable");
  return {
    spot: num(body.spot),
    contracts: body.contracts.map((contract) => ({
      symbol: String(contract.symbol ?? ""), contract: String(contract.contract ?? "").toUpperCase() as "CALL" | "PUT", expiry: String(contract.expiry ?? ""),
      strike: num(contract.strike), premium: num(contract.premium), bid: num(contract.bid), ask: num(contract.ask), openInterest: num(contract.openInterest), volume: num(contract.volume),
      iv: num(contract.iv), delta: num(contract.delta), score: num(contract.score), riskReward: num(contract.riskReward), lotSize: num(contract.lotSize), tickSize: num(contract.tickSize), freezeQuantity: num(contract.freezeQuantity),
    })),
  };
}

function automationState(actor: string, sessionId: string) {
  const service = getMonitoringService();
  const session = service.getSession(actor, sessionId);
  const configuration = session ? service.getConfiguration(session.configurationId) : undefined;
  return { session, configuration };
}

function statusPayload(extra: Raw = {}) {
  const trader = aiTrader();
  const orders = trader.listOrders().filter((order) => order.status !== "SIMULATED").slice(-10).reverse();
  return { mode: "PAPER", risk: trader.riskSnapshot(), limits: autoTradeLimitsFromEnv(), orders, ...extra };
}

export async function GET(request: Request) {
  const actor = request.headers.get("x-user-id");
  if (!actor) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  const { configuration } = automationState(actor, sessionId);
  return NextResponse.json(statusPayload({ automationEnabled: Boolean(configuration?.automationEnabled) }));
}

export async function POST(request: Request) {
  const actor = request.headers.get("x-user-id");
  if (!actor) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Raw;
  const symbol = String(body.symbol ?? "NIFTY").toUpperCase();
  const sessionId = String(body.sessionId ?? "");
  if (!isIntelSymbol(symbol)) return NextResponse.json({ error: "Unsupported symbol" }, { status: 400 });
  const { session, configuration } = automationState(actor, sessionId);
  const trader = aiTrader();
  // Positions opened by the AI keep being managed (stops, targets, square-off) even after the
  // trader switches auto-trade or monitoring off; only new entries need automation to be on.
  const entriesAllowed = Boolean(session && session.state === "ACTIVE" && configuration?.monitoringEnabled && configuration.automationEnabled && configuration.mode === "PAPER");
  if (!entriesAllowed && trader.riskSnapshot().openPositions === 0) {
    if (configuration?.mode && configuration.mode !== "PAPER") return NextResponse.json({ error: "AI auto-trade runs in PAPER mode only." }, { status: 403 });
    return NextResponse.json({ error: !session || session.state !== "ACTIVE" ? "Enable AI monitoring first." : "AI auto-trade is switched off." }, { status: 409 });
  }

  const origin = new URL(request.url).origin;
  const safety = readSafeModeState();
  let chain: Awaited<ReturnType<typeof chainContracts>>;
  try {
    chain = await chainContracts(origin, symbol);
  } catch (error) {
    return NextResponse.json(statusPayload({ automationEnabled: true, decision: { allowed: false, reasons: [`Option chain unavailable: ${error instanceof Error ? error.message : "error"}; open positions are not being re-priced`] } }), { status: 503 });
  }

  // Exits first, on fresh premiums, regardless of what the AI thinks about new entries.
  await trader.tick({ symbol, spot: chain.spot, candles: [], contracts: chain.contracts, entryBlockedReason: "managing exits", settings: { maxTrades: autoTradeLimitsFromEnv().maxTradesPerDay, minimumLoss: Number(process.env.AI_AUTOTRADE_MAX_LOSS_PER_TRADE ?? 2500), minimumProfit: 0 } });

  if (!entriesAllowed || !session || !configuration) return NextResponse.json(statusPayload({ automationEnabled: false, decision: { allowed: false, reasons: ["Auto-trade is off: managing the open AI position until it exits"] } }));

  let advice = cachedAdvice(symbol, 90_000);
  if (!advice) {
    try {
      const fresh = await getAdvice(symbol, origin);
      advice = { at: Date.now(), advice: fresh.advice, spot: fresh.spot };
      if (!fresh.cached) { try { getMonitoringService().recordAdvice(actor, session.id, { ...fresh.advice, source: fresh.advice.source }); } catch { /* session stopped */ } }
    } catch (error) {
      return NextResponse.json(statusPayload({ automationEnabled: true, decision: { allowed: false, reasons: [`AI suggestion unavailable: ${error instanceof Error ? error.message : "error"}`] } }));
    }
  }
  const advised = advice.advice.contract ? chain.contracts.find((contract) => contract.symbol === advice!.advice.contract!.trading_symbol) : undefined;
  const verdict = evaluateAutoTrade({
    symbol,
    advice: advice.advice,
    adviceAgeMs: Date.now() - advice.at,
    adviceSpot: advice.spot,
    liveSpot: chain.spot || advice.spot,
    livePremium: advised && advised.premium > 0 ? advised.premium : null,
    confidenceThreshold: configuration.confidenceThreshold,
    risk: trader.riskSnapshot(),
    limits: autoTradeLimitsFromEnv(),
    killSwitch: safety.killSwitch,
    safeMode: safety.safeMode,
  });
  if (!verdict.allowed || !verdict.signal) return NextResponse.json(statusPayload({ automationEnabled: true, advice: advice.advice, decision: verdict }));

  const result = await trader.tick({ symbol, spot: chain.spot, candles: [], contracts: chain.contracts, strategySignal: verdict.signal, settings: { maxTrades: autoTradeLimitsFromEnv().maxTradesPerDay, minimumLoss: Number(process.env.AI_AUTOTRADE_MAX_LOSS_PER_TRADE ?? 2500), minimumProfit: 0 } });
  return NextResponse.json(statusPayload({ automationEnabled: true, advice: advice.advice, decision: { allowed: true, reasons: [], summary: result.summary, diagnostics: result.diagnostics.slice(0, 3) } }));
}
