import { NextResponse } from "next/server";
import { DEFAULT_BACKTEST_SETTINGS, aggregate, istDay, listSignalSource, mtfSignalSource, runBacktest, type BacktestSettings, type Signal, type StrategyId } from "../../../../../services/backtest/src/strategy-backtest";
import { BACKTEST_SYMBOLS, loadBacktestData, validateRange, type BacktestSource } from "../../../lib/backtest-data";
import { runPythonModule } from "../../../lib/python";

const STRATEGIES: Record<StrategyId, string> = {
  MTF_AI: "AI multi-timeframe (1D/15m/5m/1m + candle psychology)",
  ORB_RETEST: "V5 ORB break-and-retest (strategy rules)",
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; };
const hhmm = (value: unknown, fallback: string) => (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback);

function settingsFrom(raw: Record<string, unknown>): BacktestSettings {
  const d = DEFAULT_BACKTEST_SETTINGS;
  return {
    capital: clampNumber(raw.capital, d.capital, 1_000, 1e9),
    lots: clampNumber(raw.lots, d.lots, 1, 50),
    lotSize: clampNumber(raw.lotSize, d.lotSize, 1, 5_000),
    pnlMode: raw.pnlMode === "POINTS" ? "POINTS" : "OPTION",
    delta: clampNumber(raw.delta, d.delta, 0.05, 1),
    thetaPerDay: clampNumber(raw.thetaPerDay, d.thetaPerDay, 0, 500),
    slippagePoints: clampNumber(raw.slippagePoints, d.slippagePoints, 0, 100),
    chargesPerTrade: clampNumber(raw.chargesPerTrade, d.chargesPerTrade, 0, 10_000),
    partialAtT1: raw.partialAtT1 === undefined ? d.partialAtT1 : Boolean(raw.partialAtT1),
    timeStopMinutes: clampNumber(raw.timeStopMinutes, d.timeStopMinutes, 0, 240),
    maxTradesPerDay: clampNumber(raw.maxTradesPerDay, d.maxTradesPerDay, 1, 20),
    maxDailyLoss: clampNumber(raw.maxDailyLoss, d.maxDailyLoss, 100, 1e9),
    maxConsecutiveLosses: clampNumber(raw.maxConsecutiveLosses, d.maxConsecutiveLosses, 1, 20),
    cooldownMinutes: clampNumber(raw.cooldownMinutes, d.cooldownMinutes, 0, 240),
    minConfidence: clampNumber(raw.minConfidence, d.minConfidence, 0, 100),
    entryStart: hhmm(raw.entryStart, d.entryStart),
    entryEnd: hhmm(raw.entryEnd, d.entryEnd),
    squareOff: hhmm(raw.squareOff, d.squareOff),
  };
}

export async function GET() {
  return NextResponse.json({ strategies: Object.entries(STRATEGIES).map(([id, label]) => ({ id, label })), symbols: BACKTEST_SYMBOLS, defaults: DEFAULT_BACKTEST_SETTINGS });
}

/**
 * POST { strategy, symbol, from, to, source, settings } -> walk-forward backtest on 1-minute bars.
 * Paper simulation only: nothing here touches a broker.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const strategy = String(body.strategy ?? "MTF_AI") as StrategyId;
  const symbol = String(body.symbol ?? "NIFTY").toUpperCase();
  const from = String(body.from ?? "");
  const to = String(body.to ?? "");
  const source: BacktestSource = body.source === "yahoo" ? "yahoo" : body.source === "synthetic" ? "synthetic" : "groww";
  if (!(strategy in STRATEGIES)) return NextResponse.json({ error: "Unknown strategy" }, { status: 400 });
  if (!(BACKTEST_SYMBOLS as readonly string[]).includes(symbol)) return NextResponse.json({ error: "Backtests support NIFTY, BANKNIFTY and SENSEX" }, { status: 400 });
  const rangeError = validateRange(from, to);
  if (rangeError) return NextResponse.json({ error: rangeError }, { status: 400 });
  const settings = settingsFrom((body.settings ?? {}) as Record<string, unknown>);
  const started = Date.now();
  const data = await loadBacktestData({ symbol, from, to, source, origin: new URL(request.url).origin });
  if (!data.sessions) return NextResponse.json({ error: `No 1-minute data for ${symbol} between ${from} and ${to}. ${data.issues.slice(0, 3).join("; ")}`, issues: data.issues }, { status: 422 });

  let signalAt: Parameters<typeof runBacktest>[0]["signalAt"];
  if (strategy === "MTF_AI") signalAt = mtfSignalSource(symbol, data.minute, data.daily);
  else {
    try {
      const replay = await runPythonModule<{ signals: Array<{ time: number; side: 1 | -1; stop: number; target1: number; reason: string }> }>("tradepulse_quant.backtest.orb_backtest", { symbol, from, candles_5m: aggregate(data.minute, 5), daily_candles: data.daily }, 120_000);
      signalAt = listSignalSource(replay.signals.map((signal): Signal => ({ ...signal, strategy: "ORB retest", target2: null })));
    } catch (error) {
      return NextResponse.json({ error: `ORB strategy replay failed: ${error instanceof Error ? error.message : "python error"}` }, { status: 503 });
    }
  }
  const result = runBacktest({ strategy, symbol, from, to, minute: data.minute, signalAt, settings });
  const notes = [...result.notes];
  if (strategy === "MTF_AI") notes.push("Replays the deterministic multi-timeframe engine the AI monitor relies on. The LLM's discretionary layer, live OI/PCR flow and sentiment cannot be replayed historically.");
  else notes.push("Replays the V5 ORB strategy rules. Live-only no-trade gates (OI flow, India VIX, broker health) have no history and are not applied.");
  if (data.delayed) notes.push("Some days came from the delayed Yahoo feed; historical candles are still valid for a backtest.");
  if (source === "synthetic") notes.unshift("SYNTHETIC DEMO DATA: a seeded random walk for exploring the tool. These numbers say nothing about real-market performance.");
  // 1-minute candles of the tested sessions (warm-up days excluded) for the candlestick view, as
  // compact [time, open, high, low, close, volume] rows; the browser aggregates other timeframes.
  const candles = data.minute.filter((bar) => { const day = istDay(bar.time); return day >= from && day <= to; }).map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume ?? 0]);
  return NextResponse.json({ ...result, candles, strategyLabel: STRATEGIES[strategy], source: data.provider, sessions: data.sessions, issues: data.issues, notes, elapsedMs: Date.now() - started });
}
