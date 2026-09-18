import { NextResponse } from "next/server";
import { AutoOptionTrader } from "../../../../../services/paper-trading/src/auto-option-trader";
import { readSafeModeState } from "../../../../../services/execution/src/safe-mode";

const trader = new AutoOptionTrader({ maxTrades: 3, minScore: 75, minRiskReward: 2 });

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
  try {
    const status = await trader.tick({
      symbol,
      spot,
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
    return NextResponse.json({ ...status, symbol, spot, source: "Live market candles + Groww option chain" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Auto option scan failed" }, { status: 503 });
  }
}

export async function DELETE() {
  return NextResponse.json({ error: "The auto option engine is session-scoped and resets with the server process." }, { status: 405 });
}
