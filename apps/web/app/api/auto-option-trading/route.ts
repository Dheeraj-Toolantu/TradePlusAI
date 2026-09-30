import { NextResponse } from "next/server";
import { AutoOptionTrader } from "../../../../../services/paper-trading/src/auto-option-trader";
import { readSafeModeState } from "../../../../../services/execution/src/safe-mode";
import { getMarketIntel, isIntelSymbol, type MarketIntel } from "../../../lib/market-intel";

// Entries come only from confirmed setups: a smart zone reversal (5m order block / FVG /
// support-resistance / writer wall + 1m CHoCH) or a fresh ORB/VWAP signal. The old
// "3-candle EMA trend" entries chased moves in the middle of nowhere and are disabled.
const trader = new AutoOptionTrader({ maxTrades: 3, minScore: 75, minRiskReward: 2, trendEntries: false });

type RecordValue = Record<string, unknown>;

function numberOf(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export async function GET() {
  return NextResponse.json({ mode: "PAPER", enabled: true, maxTrades: 3, minimumLoss: 2500, minimumProfit: 0, message: "POST a live market snapshot and auto-risk settings to run one auto-option scan." });
}

export async function POST(request: Request) {
  const safety = readSafeModeState();
  if (safety.killSwitch || safety.safeMode) {
    return NextResponse.json({ error: safety.killSwitch ? `KILL_SWITCH_ACTIVE: ${safety.killSwitchReason}` : `SAFE_MODE_ACTIVE: ${safety.safeModeReason}` }, { status: 403 });
  }
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
  // A fresh V5 strategy signal (ORB break-and-retest / VWAP reclaim) is its own directional
  // evidence: opening-range breaks start FROM sideways conditions, so a SIDEWAYS verdict or
  // missing intel must not veto it. Extreme VIX and an opposing verdict still do.
  const rawSignal = (body.strategySignal ?? null) as RecordValue | null;
  const clientSignal = rawSignal && (rawSignal.side === "BUY" || rawSignal.side === "SELL") && String(rawSignal.id ?? "")
    ? { id: String(rawSignal.id), strategy: String(rawSignal.strategy ?? "ORB_RETEST"), side: rawSignal.side as "BUY" | "SELL", entry: numberOf(rawSignal.entry), stopLoss: numberOf(rawSignal.stopLoss), target: numberOf(rawSignal.target), reason: String(rawSignal.reason ?? "") }
    : undefined;
  // The smart zone engine has already weighed trend, writers, PCR, VIX and sentiment (and
  // halves size on counter-trend reversals), so the plain verdict does not veto it.
  const smartSignal = smart?.status === "ENTRY" && smart.id && smart.spot && smart.side
    ? { id: `SMART:${smart.id}`, strategy: "SMART_ZONE", side: smart.side === "CE" ? "BUY" as const : "SELL" as const, entry: smart.spot.entry, stopLoss: smart.spot.stop, target: smart.spot.target1, reason: smart.headline ?? "", preferredSymbol: smart.contract?.trading_symbol || undefined, ignoreMarketBias: true }
    : undefined;
  const strategySignal = smartSignal ?? clientSignal;
  const waitingFor = smart ? (smart.status === "BLOCKED" ? smart.headline : smart.reason) : "market intelligence (zones, OI flow, VIX) is unavailable";
  const entryBlockedReason = intel?.available && intel.volatility?.regime === "EXTREME" ? "India VIX is in the EXTREME regime" : undefined;
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
    return NextResponse.json({ ...status, symbol, spot, marketBias: bias ?? null, smartEntry: smart ?? null, source: "1m/5m candles + Groww option chain + OI flow + VIX + sentiment (market-intel)" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Auto option scan failed" }, { status: 503 });
  }
}

export async function DELETE() {
  return NextResponse.json({ error: "The auto option engine is session-scoped and resets with the server process." }, { status: 405 });
}
