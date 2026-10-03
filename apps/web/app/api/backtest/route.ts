import { NextResponse } from "next/server";
import { DEFAULT_BACKTEST_SETTINGS, aggregate, istDay, listSignalSource, mtfSignalSource, runBacktest, type BacktestSettings, type Signal, type StrategyId } from "../../../../../services/backtest/src/strategy-backtest";
import { smcSignalSource } from "../../../../../services/backtest/src/smc-strategy";
import { trendPullbackSignalSource } from "../../../../../services/backtest/src/trend-pullback-strategy";
import { smartSignalSource } from "../../../../../services/backtest/src/smart-strategy";
import { orbProSignalSource } from "../../../../../services/backtest/src/orb-pro-strategy";
import { optimizeSettings, precomputeSignals } from "../../../../../services/backtest/src/optimizer";
import { BACKTEST_SYMBOLS, loadBacktestData, validateRange, validateSourceRange, type BacktestSource } from "../../../lib/backtest-data";
import { runPythonModule } from "../../../lib/python";

const STRATEGIES: Record<StrategyId, string> = {
  MTF_AI: "AI multi-timeframe (1D/15m/5m/1m + candle psychology)",
  ORB_RETEST: "V5 ORB break-and-retest (strategy rules)",
  ORB_PRO: "ORB retest Pro (sentiment, conviction breakout, held retest, structural stop)",
  SMC_SWEEP: "SMC liquidity sweep + 9 EMA (S/R, CHoCH, FVG/OB, 15m 9 EMA trend, 1m close-back confirmation)",
  SMC_PLUS: "SMC sweep + CHoCH retest (adds 5m CHoCH → FVG/OB retest continuation entries in the 9 EMA trend)",
  TREND_PULLBACK: "Trend-day VWAP pullback (regime filter, value pullback, trailing runner)",
  SMART_COMBO: "Smart combo (regime-routed trend / ORB / SMC, AI multi-timeframe vote)",
};
/** Above this many sessions the chart gets 5-minute candles to keep the response small (about 3 months). */
const MINUTE_CANDLE_SESSIONS = 70;

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
    trailR: clampNumber(raw.trailR, d.trailR, 0, 5),
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
  const rangeError = validateRange(from, to) ?? validateSourceRange(source, from);
  if (rangeError) return NextResponse.json({ error: rangeError }, { status: 400 });
  const settings = settingsFrom((body.settings ?? {}) as Record<string, unknown>);
  const started = Date.now();
  const data = await loadBacktestData({ symbol, from, to, source, origin: new URL(request.url).origin });
  if (!data.sessions) {
    // Lead with the provider's own explanation when there is one (first issue is the missing-days list).
    const cause = data.issues.find((issue) => !issue.startsWith("No 1-minute candles for"));
    const hint = cause ?? (source === "groww" ? "Check that the Groww API is connected (GROWW_API_KEY / secret) and that the dates are trading days." : "Yahoo only serves the last ~30 days of 1-minute candles; use Groww history for older periods.");
    return NextResponse.json({ error: `No 1-minute candles for ${symbol} between ${from} and ${to}. ${hint}`, issues: data.issues }, { status: 422 });
  }

  // The V5 ORB rules live in the Python engine: replay them once per request.
  const orbSignals = async () => {
    const replay = await runPythonModule<{ signals: Array<{ time: number; side: 1 | -1; stop: number; target1: number; reason: string }> }>("tradepulse_quant.backtest.orb_backtest", { symbol, from, candles_5m: aggregate(data.minute, 5), daily_candles: data.daily }, 120_000);
    return replay.signals.map((signal): Signal => ({ ...signal, strategy: "ORB retest", target2: null }));
  };
  let signalAt: Parameters<typeof runBacktest>[0]["signalAt"];
  let smartFunnel: ReturnType<typeof smartSignalSource>["funnel"] | null = null;
  let orbProFunnel: ReturnType<typeof orbProSignalSource>["funnel"] | null = null;
  let orbNote: string | null = null;
  let funnel: ReturnType<typeof smcSignalSource>["funnel"] | null = null;
  let trendFunnel: ReturnType<typeof trendPullbackSignalSource>["funnel"] | null = null;
  if (strategy === "MTF_AI") signalAt = mtfSignalSource(symbol, data.minute, data.daily);
  else if (strategy === "SMC_SWEEP" || strategy === "SMC_PLUS") { const smc = smcSignalSource(symbol, data.minute, data.daily, { chochRetest: strategy === "SMC_PLUS" }); funnel = smc.funnel; signalAt = smc; }
  else if (strategy === "TREND_PULLBACK") { const trend = trendPullbackSignalSource(symbol, data.minute, data.daily); trendFunnel = trend.funnel; signalAt = trend; }
  else if (strategy === "ORB_PRO") { const pro = orbProSignalSource(symbol, data.minute, data.daily); orbProFunnel = pro.funnel; signalAt = pro; }
  else if (strategy === "SMART_COMBO") {
    // ORB is one of four playbooks here: if the Python replay is unavailable, run without it.
    let orb: Signal[] | null = null;
    try { orb = await orbSignals(); } catch (error) { orbNote = `ORB playbook skipped: ${error instanceof Error ? error.message : "python error"}`; }
    const smart = smartSignalSource(symbol, data.minute, data.daily, { orbSignals: orb });
    smartFunnel = smart.funnel;
    signalAt = smart;
  }
  else {
    try {
      signalAt = listSignalSource(await orbSignals());
    } catch (error) {
      return NextResponse.json({ error: `ORB strategy replay failed: ${error instanceof Error ? error.message : "python error"}` }, { status: 503 });
    }
  }
  // Signals do not depend on the simulator's settings: compute them once, then replay cheaply.
  signalAt = precomputeSignals(data.minute, signalAt, from, to);
  const result = runBacktest({ strategy, symbol, from, to, minute: data.minute, signalAt, settings });
  const optimization = body.optimize ? optimizeSettings({ strategy, symbol, from, to, minute: data.minute, signalAt, settings, usesConfidence: strategy !== "ORB_RETEST" }) : null;
  const notes = [...result.notes];
  if (strategy === "MTF_AI") notes.push("Replays the deterministic multi-timeframe engine the AI monitor relies on. The LLM's discretionary layer, live OI/PCR flow and sentiment cannot be replayed historically.");
  else if (strategy === "SMC_SWEEP" || strategy === "SMC_PLUS") {
    if (funnel && strategy === "SMC_PLUS") notes.push(`CHoCH retest: ${funnel.chochBreaks} 5m CHoCH breaks with displacement → ${funnel.chochEntries} retest entries (included in the funnel below).`);
    if (strategy === "SMC_PLUS") notes.push("SMC sweep + CHoCH retest, validated on real 1-minute data 2018–2026 (trail 1.5R, 45-min time stop): NIFTY 191 trades (~22 a year), 58% win, +0.18R/trade, points PF 1.60, no losing year; BANKNIFTY 207 trades, 54% win, +0.13R, PF 1.38. The CHoCH retests alone: NIFTY 57% win, +0.16R; BANKNIFTY 56% win, +0.11R. Sweeps here may use the 5m 9 EMA trend when the 15m one has not turned yet.");
    if (funnel) notes.push(`Setup funnel: ${funnel.sweeps} liquidity sweeps → ${funnel.choch} CHoCH with displacement → ${funnel.zones} FVG/OB zones → ${funnel.entries} entry triggers. Dropped: ${funnel.invalidated} sweep not held, ${funnel.noChoch} no CHoCH, ${funnel.expired} no retrace within 60 min, ${funnel.stopTooWide} stop > 2.5 ATR, ${funnel.srTooClose} S/R within 1R, ${funnel.againstEma} against the 15m 9 EMA trend, ${funnel.againstVwap} wrong side of VWAP, ${funnel.lateSession} after 14:30. Entry triggers can exceed trades: the daily risk limits and one-position rule apply after.`);
    notes.push("SMC + 9 EMA rules: liquidity sweep of PDH/PDL, opening range, swing or equal highs/lows → CHoCH with displacement → retrace into the FVG/order block → 1m candle closing back out of the zone. Only with the 15m 9 EMA trend (15m close beyond a 9 EMA sloping the trade's way) and on the trade's side of VWAP. Stop beyond the sweep; T1 1R or opposing liquidity, then breakeven; runner trails (1.5R) or T2 at the next opposing liquidity. Confidence rises for an entry at value near the 5m 9 EMA, an FVG inside the order block and a daily-level sweep.");
    if (strategy === "SMC_SWEEP") notes.push("Validated on real 1-minute data 2018–2026 (trail 1.5R, 45-min time stop): NIFTY 82 trades, 59% win, +0.19R/trade, points PF 1.64; BANKNIFTY (not used for design) 94 trades, 55% win, +0.19R, PF 1.70. The previous rules lost on the same data (−0.05R / −0.12R). Expect ~10 trades a year: an A+ setup, not a daily signal.");
  }
  else if (strategy === "ORB_PRO") {
    if (orbProFunnel) {
      const f = orbProFunnel;
      notes.push(`Setup funnel: ${f.days} sessions (${f.gapDays} gap days, ${f.orTooWide} skipped for an opening range > 0.6 ADR) → ${f.breakouts} conviction breakouts (${f.weakBreakouts} weak pokes ignored) → ${f.retests} retests → ${f.triggers} 1m triggers. Dropped: ${f.failedBreakouts} failed back inside, ${f.deepRetests} retest past the range midpoint, ${f.expired} no retest/trigger in time, ${f.notAccepted} not accepted beyond the level, ${f.choppy} choppy session (efficiency < 0.30), ${f.againstVwap} wrong side of VWAP, ${f.stopTooWide} honest stop > 1.3 ATR, ${f.noRoom} previous-day high/low within 1R.`);
    }
    notes.push("ORB Pro rules: gap days are skipped (on real NIFTY 2024–26 they lost; validated walk-forward) → 15-min opening range → 5m breakout with body, outer close and range expansion → acceptance (another 5m close beyond the level) on a directional session (efficiency ≥ 0.30) → retest of the level that holds (no close back inside, no wick past mid-range) → 1m turn beyond the level on the right side of VWAP. Stop beyond the retest extreme and the level + buffer, pushed past nearby round numbers, ≥ 0.5 ATR, skipped if > 1.3 ATR. T1 measured move (1–1.5R), then breakeven and a 1R trail to T2 (two range-widths capped at the previous-day high/low and 4R); no time stop.");
  }
  else if (strategy === "SMART_COMBO") {
    if (smartFunnel) {
      const f = smartFunnel;
      const bars = f.regimeBars.TREND + f.regimeBars.RANGE + f.regimeBars.UNDECIDED || 1;
      notes.push(`Regime: ${Math.round(100 * f.regimeBars.TREND / bars)}% of minutes on trend days, ${Math.round(100 * f.regimeBars.RANGE / bars)}% range, ${Math.round(100 * f.regimeBars.UNDECIDED / bars)}% undecided. Playbook signals: trend ${f.candidates.TREND}, sweep ${f.candidates.SMC}, ORB ${f.candidates.ORB} → taken by the router: trend ${f.accepted.TREND}, sweep ${f.accepted.SMC}, ORB ${f.accepted.ORB}. Blocked by regime ${f.rejectedByRegime}, vetoed by the AI multi-timeframe read ${f.vetoedByAi}; AI confirmed ${f.confirmedByAi}, multi-playbook confluence ${f.confluence}.`);
    }
    notes.push("Smart combo: trend day → trend pullbacks, ORB and sweeps only in the trend's direction; range day → sweep reversals only; undecided → sweeps of daily levels and ORB with the day's direction. The AI multi-timeframe engine votes (an opposite read vetoes, an agreeing one adds confidence). Stops and targets come from the playbook that fired.");
    if (orbNote) notes.push(orbNote);
  }
  else if (strategy === "TREND_PULLBACK") {
    if (trendFunnel) notes.push(`Setup funnel: ${trendFunnel.evaluated} 5m closes checked → ${trendFunnel.trendBars} on a confirmed trend day → ${trendFunnel.pullbacks} pullbacks into value → ${trendFunnel.triggers} resumption candles (${trendFunnel.extended} too far from VWAP, ${trendFunnel.tooWide} stop > 1.6 ATR).`);
    notes.push("Trend-day rules: 30 min on one side of a sloping VWAP + opening-range break or ≥ 0.5 ADR from the open + 15m EMA20 agreeing → pullback to VWAP/EMA20 that holds → 5m resumption candle. Stop beyond the pullback (0.6–1.6 ATR). Best with a trailing runner (Trail = 1.5R, 45-min time stop).");
  }
  else notes.push("Replays the V5 ORB strategy rules (opening range, break, retest/hold, structural stop, 2R capped at PDH/PDL). Not applied: live-only gates (OI flow, India VIX, broker health) and the live engine's regime/score gates, so live trading is stricter than this replay.");
  if (data.delayed) notes.push("Some days came from the delayed Yahoo feed; historical candles are still valid for a backtest.");
  if (source === "synthetic") notes.unshift("SYNTHETIC DEMO DATA: a seeded random walk for exploring the tool. These numbers say nothing about real-market performance.");
  // Candles of the tested sessions (warm-up days excluded) for the candlestick view: 1-minute, or
  // 5-minute for long ranges, as compact [time, open, high, low, close, volume] rows; the browser
  // aggregates other timeframes.
  const tested = data.minute.filter((bar) => { const day = istDay(bar.time); return day >= from && day <= to; });
  const candleMinutes = data.sessions > MINUTE_CANDLE_SESSIONS ? 5 : 1;
  const row = (bar: { time: number; open: number; high: number; low: number; close: number; volume?: number | null }) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume ?? 0];
  const candles = (candleMinutes === 1 ? tested : aggregate(tested, candleMinutes)).map(row);
  // With 5-minute chart candles, still ship 1-minute candles for every day that had a trade, so the
  // day replay prints minute by minute (a 5-minute trade would otherwise open and close in one candle).
  const tradeDays = new Set(result.trades.map((trade) => trade.day));
  const replayMinutes = candleMinutes === 1 ? null : Object.fromEntries([...tradeDays].map((day) => [day, tested.filter((bar) => istDay(bar.time) === day).map(row)]));
  // Daily candles (up to ~1 year before `to`) for the 1D / 1M support-resistance levels on the chart.
  const dailyCandles = [...data.daily].sort((a, b) => a.time - b.time).filter((bar) => istDay(bar.time) <= to).slice(-260).map(row);
  return NextResponse.json({ ...result, optimization, candles, candleMinutes, replayMinutes, dailyCandles, strategyLabel: STRATEGIES[strategy], source: data.provider, sessions: data.sessions, issues: data.issues, notes, elapsedMs: Date.now() - started });
}
