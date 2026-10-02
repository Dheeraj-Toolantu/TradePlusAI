import { NextResponse } from "next/server";
import { AutoOptionTrader } from "../../../../../services/paper-trading/src/auto-option-trader";
import { readSafeModeState } from "../../../../../services/execution/src/safe-mode";
import { getMarketIntel, isIntelSymbol, type MarketIntel } from "../../../lib/market-intel";

// Entries come only from a confirmed smart zone reversal (5m order block / FVG / support-
// resistance / writer wall + 1m CHoCH). ORB/VWAP signals and the old "3-candle EMA trend"
// entries are not used by the auto engine.
// Paper fills include slippage, open positions are squared off at 15:15 IST, and the day's
// realised losses stop new entries (see dailyStop below).
const trader = new AutoOptionTrader({ maxTrades: 3, minScore: 75, minRiskReward: 2, trendEntries: false, slippagePct: Number(process.env.AUTO_OPTION_SLIPPAGE_PCT ?? 0.5) / 100, squareOffIst: "15:15" });
const MAX_DAILY_LOSS = Number(process.env.AUTO_OPTION_MAX_DAILY_LOSS ?? 3000);
const MAX_CONSECUTIVE_LOSSES = 2;
const COOLDOWN_MINUTES = 15;

/** Daily stop for new entries: loss limit, consecutive losses, and a cooldown after a loss. */
function dailyStop(): string | undefined {
  const risk = trader.riskSnapshot();
  if (risk.realizedPnlToday <= -MAX_DAILY_LOSS) return `daily loss limit reached (₹${Math.abs(risk.realizedPnlToday)} of ₹${MAX_DAILY_LOSS})`;
  if (risk.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) return `${risk.consecutiveLosses} consecutive losses: entries stopped for the day`;
  if (risk.lastLossExitAt && Date.now() - Date.parse(risk.lastLossExitAt) < COOLDOWN_MINUTES * 60_000) return `cooling down for ${COOLDOWN_MINUTES} minutes after a loss`;
  return undefined;
}

type RecordValue = Record<string, unknown>;

function numberOf(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export async function GET() {
  return NextResponse.json({ mode: "PAPER", enabled: true, maxTrades: 3, minimumLoss: 2500, minimumProfit: 0, message: "POST a live market snapshot and auto-risk settings to run one auto-option scan." });
}

export async function POST(request: Request) {
  // The kill switch / safe mode stop NEW entries; open positions must still be managed to an
  // exit (stop, target, trailing, square-off), so the scan keeps running for exits only.
  const safety = readSafeModeState();
  const safetyBlock = safety.killSwitch ? `KILL_SWITCH_ACTIVE: ${safety.killSwitchReason}` : safety.safeMode ? `SAFE_MODE_ACTIVE: ${safety.safeModeReason}` : undefined;
  const body = await request.json().catch(() => ({})) as RecordValue;
  const symbol = String(body.symbol ?? "NIFTY").toUpperCase();
  const spot = numberOf(body.spot);
  const candles = Array.isArray(body.candles) ? body.candles : [];
  const contracts = Array.isArray(body.contracts) ? body.contracts : [];
  if (!symbol || spot <= 0 || candles.length < 3 || contracts.length === 0) {
    return NextResponse.json({ error: "Auto option scan requires a live spot, at least 3 candles, and option-chain contracts." }, { status: 400 });
  }
  // Intel is cached for 20 s and shared with the trade desk, so a 1-minute trigger is seen
  // within one scan. Missing intel pauses smart entries; exits still run.
  let intel: MarketIntel | null = null;
  if (isIntelSymbol(symbol)) {
    intel = await getMarketIntel(symbol, { origin: new URL(request.url).origin }).catch(() => null);
  }
  const smart = intel?.available ? intel.smart_entry : undefined;
  const bias = intel?.available ? intel.verdict?.bias : undefined;
  // Auto entries come only from the smart zone engine (5m zone + 1m CHoCH). It has already
  // weighed trend, writers, PCR, VIX and sentiment, so the plain verdict does not veto it.
  // ORB/VWAP signals are deliberately not used here.
  const smartSignal = smart?.status === "ENTRY" && smart.id && smart.spot && smart.side
    ? { id: `SMART:${smart.id}`, strategy: "SMART_ZONE", side: smart.side === "CE" ? "BUY" as const : "SELL" as const, entry: smart.spot.entry, stopLoss: smart.spot.stop, target: smart.spot.target1, reason: smart.headline ?? "", preferredSymbol: smart.contract?.trading_symbol || undefined, ignoreMarketBias: true }
    : undefined;
  const strategySignal = smartSignal;
  const waitingFor = smart ? (smart.status === "BLOCKED" ? smart.headline : smart.reason) : "market intelligence (zones, OI flow, VIX) is unavailable";
  const entryBlockedReason = safetyBlock ?? dailyStop() ?? (intel?.available && intel.volatility?.regime === "EXTREME" ? "India VIX is in the EXTREME regime" : undefined);
  const trendBlockedReason = !intel?.available
    ? "market intelligence (trend, OI flow, VIX) is unavailable"
    : bias === "SIDEWAYS"
      ? "no clear trend (confluence verdict is SIDEWAYS)"
      : undefined;
  try {
    const status = await trader.tick({
      symbol,
      spot,
      marketBias: bias,
      entryBlockedReason,
      trendBlockedReason,
      strategySignal,
      waitingFor,
      settings: {
        maxTrades: numberOf(body.maxTrades) || 3,
        minimumLoss: numberOf(body.minimumLoss) || 2500,
        minimumProfit: numberOf(body.minimumProfit),
      },
      candles: candles.map((candle: RecordValue) => ({
        timestamp: String(candle.timestamp ?? new Date().toISOString()),
        open: numberOf(candle.open),
        high: numberOf(candle.high),
        low: numberOf(candle.low),
        close: numberOf(candle.close),
        volume: numberOf(candle.volume),
      })),
      contracts: contracts.map((contract: RecordValue) => ({
        symbol: String(contract.symbol ?? ""),
        contract: String(contract.contract ?? "").toUpperCase() as "CALL" | "PUT",
        expiry: String(contract.expiry ?? ""),
        strike: numberOf(contract.strike),
        premium: numberOf(contract.premium),
        bid: numberOf(contract.bid),
        ask: numberOf(contract.ask),
        openInterest: numberOf(contract.openInterest),
        volume: numberOf(contract.volume),
        iv: numberOf(contract.iv),
        delta: numberOf(contract.delta),
        score: numberOf(contract.score),
        riskReward: numberOf(contract.riskReward),
        lotSize: numberOf(contract.lotSize),
        tickSize: numberOf(contract.tickSize),
        freezeQuantity: numberOf(contract.freezeQuantity),
      })),
    });
    return NextResponse.json({ ...status, risk: trader.riskSnapshot(), symbol, spot, marketBias: bias ?? null, smartEntry: smart ?? null, source: "1m/5m candles + Groww option chain + OI flow + VIX + sentiment (market-intel)" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Auto option scan failed" }, { status: 503 });
  }
}

export async function DELETE() {
  return NextResponse.json({ error: "The auto option engine is session-scoped and resets with the server process." }, { status: 405 });
}
