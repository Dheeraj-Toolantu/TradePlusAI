import { analyzeMultiTimeframe, type Bar } from "../../ai-monitoring/src/mtf-decision-engine";

/**
 * Strategy backtester for the /validation page.
 *
 * Strategies only decide WHEN and WHERE (side, stop, targets) using candles that were complete at
 * that moment. This simulator then replays the trade minute by minute on 1-minute bars with the same
 * rules the auto-traders use: next-bar fills with slippage, stop-before-target when both are touched
 * in one bar, half booked at T1 with the stop moved to entry, a time stop, 15:15 square-off, and the
 * daily risk limits (max trades, daily loss, consecutive losses, cooldown, one position at a time).
 *
 * P&L is either index points (futures-like) or an option-buyer approximation: points x delta, minus a
 * time-decay estimate and charges. Historical option premiums are not replayed, so option P&L is an
 * estimate; the index-points view is exact for the given candles.
 */

export type StrategyId = "MTF_AI" | "ORB_RETEST" | "SMC_SWEEP";
export type PnlMode = "OPTION" | "POINTS";

export type BacktestSettings = {
  /** Account capital, for drawdown and return percentages. */
  capital: number;
  lots: number;
  lotSize: number;
  pnlMode: PnlMode;
  /** Option delta used to map spot points to premium points. */
  delta: number;
  /** Option time decay in premium points per trading day (375 minutes). */
  thetaPerDay: number;
  /** Slippage per side in index points. */
  slippagePoints: number;
  /** Brokerage + taxes per round trip, in rupees. */
  chargesPerTrade: number;
  partialAtT1: boolean;
  /** Exit if the trade is not +0.5R within this many minutes (0 = off). */
  timeStopMinutes: number;
  maxTradesPerDay: number;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  /** Minimum strategy confidence for an entry (MTF strategy). */
  minConfidence: number;
  entryStart: string;
  entryEnd: string;
  squareOff: string;
};

export const DEFAULT_BACKTEST_SETTINGS: BacktestSettings = {
  capital: 100_000, lots: 1, lotSize: 65, pnlMode: "OPTION", delta: 0.5, thetaPerDay: 12, slippagePoints: 1, chargesPerTrade: 60,
  partialAtT1: true, timeStopMinutes: 15, maxTradesPerDay: 3, maxDailyLoss: 3000, maxConsecutiveLosses: 2, cooldownMinutes: 15,
  minConfidence: 60, entryStart: "09:35", entryEnd: "14:45", squareOff: "15:15",
};

export type Signal = { time: number; side: 1 | -1; stop: number; target1: number; target2?: number | null; confidence?: number; strategy: string; reason: string };

export type TradeLeg = { time: number; price: number; fraction: number; reason: string };
export type BacktestTrade = {
  id: number; day: string; strategy: string; side: "LONG" | "SHORT"; reason: string; confidence: number | null;
  signalTime: number; entryTime: number; entryPrice: number; stop: number; target1: number; target2: number;
  exitTime: number; exitPrice: number; exitReason: string; legs: TradeLeg[];
  points: number; rMultiple: number; pnl: number; holdMinutes: number; mfeR: number; maeR: number;
};

export type BacktestMetrics = {
  trades: number; wins: number; losses: number; winRate: number; netPnl: number; grossProfit: number; grossLoss: number;
  profitFactor: number | null; expectancy: number; expectancyR: number; averageWin: number; averageLoss: number; largestWin: number; largestLoss: number;
  maxDrawdown: number; maxDrawdownPct: number; averageHoldMinutes: number; bestDay: number; worstDay: number; tradingDays: number; profitableDays: number;
  maxConsecutiveLosses: number; totalCharges: number; returnPct: number;
};

export type BacktestResult = {
  strategy: StrategyId; symbol: string; from: string; to: string; settings: BacktestSettings;
  trades: BacktestTrade[]; metrics: BacktestMetrics;
  equity: Array<{ time: number; equity: number; drawdown: number }>;
  daily: Array<{ day: string; pnl: number; trades: number }>;
  exitReasons: Array<{ reason: string; count: number; pnl: number }>;
  byHour: Array<{ hour: string; trades: number; pnl: number; winRate: number }>;
  rDistribution: Array<{ bucket: string; count: number }>;
  skipped: Array<{ day: string; reason: string; count: number }>;
  signalsSeen: number;
  notes: string[];
};

const IST_S = 330 * 60;
export const istDay = (epochS: number) => new Date((epochS + IST_S) * 1000).toISOString().slice(0, 10);
export const istMinute = (epochS: number) => { const d = new Date((epochS + IST_S) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const clock = (value: string) => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Aggregates 1-minute bars into N-minute bars aligned to the 09:15 IST session grid. */
export function aggregate(bars: Bar[], minutes: number): Bar[] {
  const size = minutes * 60;
  const out: Bar[] = [];
  for (const bar of bars) {
    const bucket = Math.floor(bar.time / size) * size;
    const last = out.at(-1);
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, bar.high); last.low = Math.min(last.low, bar.low); last.close = bar.close;
      last.volume = (last.volume ?? 0) + (bar.volume ?? 0);
    } else out.push({ time: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0 });
  }
  return out;
}

/** Index of the last bar (of `size` seconds) fully closed by `t`, via binary search. */
function lastClosedIndex(bars: Bar[], t: number, size: number) {
  let lo = 0; let hi = bars.length - 1; let found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].time + size <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}

/**
 * Walk-forward signal source for the AI monitor's deterministic multi-timeframe engine. At each
 * 1-minute close it sees only completed 1m / 5m / 15m bars and prior daily bars.
 */
export function mtfSignalSource(symbol: string, minute: Bar[], daily: Bar[]) {
  const m5 = aggregate(minute, 5);
  const m15 = aggregate(minute, 15);
  return (index: number): Signal | null => {
    const t = minute[index].time + 60;
    const i5 = lastClosedIndex(m5, t, 300);
    const i15 = lastClosedIndex(m15, t, 900);
    const decision = analyzeMultiTimeframe({
      symbol,
      spot: minute[index].close,
      // Bounded windows: enough for EMA50/ATR/RSI, today's VWAP and recent swings on each timeframe.
      candles: { "1D": daily.filter((bar) => bar.time < t).slice(-60), "15m": m15.slice(Math.max(0, i15 - 99), i15 + 1), "5m": m5.slice(Math.max(0, i5 - 149), i5 + 1), "1m": minute.slice(Math.max(0, index - 119), index + 1) },
      now: new Date(t * 1000),
    });
    if (decision.action === "WAIT" || !decision.spot) return null;
    return { time: t, side: decision.action === "BUY_CE" ? 1 : -1, stop: decision.spot.stop, target1: decision.spot.target1, target2: decision.spot.target2, confidence: decision.confidence, strategy: "AI multi-timeframe", reason: decision.headline };
  };
}

/** Signal source from a precomputed list (e.g. the Python ORB replay), keyed by decision time. */
export function listSignalSource(signals: Signal[]) {
  const byTime = new Map(signals.map((signal) => [signal.time, signal]));
  return (index: number, minute: Bar[]) => byTime.get(minute[index].time + 60) ?? null;
}

type DayRisk = { trades: number; realized: number; consecutiveLosses: number; lastLossAt: number | null };

export function runBacktest(input: { strategy: StrategyId; symbol: string; from: string; to: string; minute: Bar[]; signalAt: (index: number, minute: Bar[]) => Signal | null; settings?: Partial<BacktestSettings> }): BacktestResult {
  const settings: BacktestSettings = { ...DEFAULT_BACKTEST_SETTINGS, ...input.settings };
  const minute = [...input.minute].sort((a, b) => a.time - b.time);
  const qty = Math.max(1, Math.round(settings.lots)) * Math.max(1, Math.round(settings.lotSize));
  const trades: BacktestTrade[] = [];
  const skipped = new Map<string, { day: string; reason: string; count: number }>();
  const skip = (day: string, reason: string) => { const key = `${day}|${reason}`; const item = skipped.get(key) ?? { day, reason, count: 0 }; item.count += 1; skipped.set(key, item); };
  const risk = new Map<string, DayRisk>();
  const dayRisk = (day: string) => { let value = risk.get(day); if (!value) { value = { trades: 0, realized: 0, consecutiveLosses: 0, lastLossAt: null }; risk.set(day, value); } return value; };
  let signalsSeen = 0;
  const [startMin, endMin, squareMin] = [clock(settings.entryStart), clock(settings.entryEnd), clock(settings.squareOff)];

  let i = 0;
  while (i < minute.length - 1) {
    const bar = minute[i];
    const day = istDay(bar.time);
    const closeMinute = istMinute(bar.time + 60);
    if (day < input.from || day > input.to || closeMinute < startMin || closeMinute > endMin) { i += 1; continue; }
    const state = dayRisk(day);
    const signal = input.signalAt(i, minute);
    if (!signal) { i += 1; continue; }
    signalsSeen += 1;
    const blocked = state.trades >= settings.maxTradesPerDay ? "Daily trade limit reached"
      : state.realized <= -settings.maxDailyLoss ? "Daily loss limit reached"
      : state.consecutiveLosses >= settings.maxConsecutiveLosses ? "Consecutive-loss stop for the day"
      : state.lastLossAt !== null && (bar.time + 60 - state.lastLossAt) < settings.cooldownMinutes * 60 ? "Cooling down after a loss"
      : (signal.confidence ?? 100) < settings.minConfidence ? "Confidence below threshold"
      : null;
    if (blocked) { skip(day, blocked); i += 1; continue; }
    const next = minute[i + 1];
    if (istDay(next.time) !== day) { skip(day, "No bar left to fill the entry"); i += 1; continue; }
    const side = signal.side;
    const entry = next.open + side * settings.slippagePoints;
    const riskPts = (entry - signal.stop) * side;
    if (!(riskPts > 0)) { skip(day, "Price gapped through the stop before the fill"); i += 1; continue; }
    const target1 = signal.target1;
    const target2 = signal.target2 && (signal.target2 - target1) * side > 0 ? signal.target2 : entry + side * 3 * riskPts;

    // Manage the trade bar by bar from the fill bar onward.
    let stop = signal.stop;
    let remaining = 1;
    let t1Hit = false;
    const legs: TradeLeg[] = [];
    let mfe = 0; let mae = 0;
    let j = i + 1;
    for (; j < minute.length; j += 1) {
      const b = minute[j];
      const end = b.time + 60;
      if (istDay(b.time) !== day) { const last = minute[j - 1]; legs.push({ time: last.time + 60, price: last.close - side * settings.slippagePoints, fraction: remaining, reason: "SESSION_END" }); remaining = 0; j -= 1; break; }
      const favourable = side > 0 ? b.high - entry : entry - b.low;
      const adverse = side > 0 ? entry - b.low : b.high - entry;
      mfe = Math.max(mfe, favourable / riskPts); mae = Math.max(mae, adverse / riskPts);
      const stopTouched = side > 0 ? b.low <= stop : b.high >= stop;
      if (stopTouched) {
        // Stops are market orders: a gap through the stop fills at the open, not the stop.
        const fill = (side > 0 ? Math.min(stop, b.open) : Math.max(stop, b.open)) - side * settings.slippagePoints;
        legs.push({ time: end, price: fill, fraction: remaining, reason: t1Hit ? "BREAKEVEN_STOP" : "STOP_LOSS" }); remaining = 0; break;
      }
      if (!t1Hit && (side > 0 ? b.high >= target1 : b.low <= target1)) {
        if (settings.partialAtT1) { legs.push({ time: end, price: target1, fraction: 0.5, reason: "TARGET_1" }); remaining = 0.5; t1Hit = true; stop = entry; }
        else { legs.push({ time: end, price: target1, fraction: remaining, reason: "TARGET_1" }); remaining = 0; break; }
      }
      if (t1Hit && (side > 0 ? b.high >= target2 : b.low <= target2)) { legs.push({ time: end, price: target2, fraction: remaining, reason: "TARGET_2" }); remaining = 0; break; }
      if (settings.timeStopMinutes > 0 && !t1Hit && end - (next.time) >= settings.timeStopMinutes * 60 && (b.close - entry) * side < 0.5 * riskPts) {
        legs.push({ time: end, price: b.close - side * settings.slippagePoints, fraction: remaining, reason: "TIME_STOP" }); remaining = 0; break;
      }
      if (istMinute(end) >= squareMin) { legs.push({ time: end, price: b.close - side * settings.slippagePoints, fraction: remaining, reason: "SQUARE_OFF" }); remaining = 0; break; }
    }
    if (remaining > 0) { const last = minute.at(-1)!; legs.push({ time: last.time + 60, price: last.close, fraction: remaining, reason: "DATA_END" }); j = minute.length - 1; }

    const points = legs.reduce((sum, leg) => sum + (leg.price - entry) * side * leg.fraction, 0);
    const exitTime = legs.at(-1)!.time;
    const holdMinutes = Math.max(1, Math.round((exitTime - next.time) / 60));
    const theta = settings.pnlMode === "OPTION" ? settings.thetaPerDay * (holdMinutes / 375) : 0;
    const perUnit = settings.pnlMode === "OPTION" ? points * settings.delta - theta : points;
    const pnl = round2(perUnit * qty - settings.chargesPerTrade);
    const exitPrice = legs.reduce((sum, leg) => sum + leg.price * leg.fraction, 0);
    const finalReason = legs.length > 1 && legs[0].reason === "TARGET_1" ? `T1 + ${legs.at(-1)!.reason.replace("_", " ").toLowerCase()}` : legs[0].reason;
    trades.push({
      id: trades.length + 1, day, strategy: signal.strategy, side: side > 0 ? "LONG" : "SHORT", reason: signal.reason, confidence: signal.confidence ?? null,
      signalTime: signal.time, entryTime: next.time, entryPrice: round2(entry), stop: round2(signal.stop), target1: round2(target1), target2: round2(target2),
      exitTime, exitPrice: round2(exitPrice), exitReason: finalReason, legs: legs.map((leg) => ({ ...leg, price: round2(leg.price) })),
      points: round2(points), rMultiple: round2(points / riskPts), pnl, holdMinutes, mfeR: round2(mfe), maeR: round2(mae),
    });
    state.trades += 1;
    state.realized += pnl;
    if (pnl < 0) { state.consecutiveLosses += 1; state.lastLossAt = exitTime; } else state.consecutiveLosses = 0;
    // Resume scanning from the exit bar: one position at a time.
    i = Math.max(j, i + 1);
  }
  return summarize({ strategy: input.strategy, symbol: input.symbol, from: input.from, to: input.to, settings, trades, skipped: [...skipped.values()], signalsSeen, minute });
}

function summarize(args: { strategy: StrategyId; symbol: string; from: string; to: string; settings: BacktestSettings; trades: BacktestTrade[]; skipped: BacktestResult["skipped"]; signalsSeen: number; minute: Bar[] }): BacktestResult {
  const { trades, settings } = args;
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const netPnl = grossProfit - grossLoss;
  let equity = 0; let peak = 0; let maxDrawdown = 0; let streak = 0; let maxStreak = 0;
  const curve: BacktestResult["equity"] = [];
  for (const trade of trades) {
    equity += trade.pnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    curve.push({ time: trade.exitTime, equity: round2(equity), drawdown: round2(equity - peak) });
    streak = trade.pnl <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
  }
  const sessionDays = [...new Set(args.minute.map((bar) => istDay(bar.time)).filter((day) => day >= args.from && day <= args.to))].sort();
  const daily = sessionDays.map((day) => { const own = trades.filter((trade) => trade.day === day); return { day, pnl: round2(own.reduce((sum, trade) => sum + trade.pnl, 0)), trades: own.length }; });
  const reasons = new Map<string, { reason: string; count: number; pnl: number }>();
  for (const trade of trades) { const item = reasons.get(trade.exitReason) ?? { reason: trade.exitReason, count: 0, pnl: 0 }; item.count += 1; item.pnl = round2(item.pnl + trade.pnl); reasons.set(trade.exitReason, item); }
  const hours = new Map<string, { hour: string; trades: number; pnl: number; wins: number }>();
  for (const trade of trades) { const h = Math.floor(istMinute(trade.entryTime) / 60); const key = `${String(h).padStart(2, "0")}:00`; const item = hours.get(key) ?? { hour: key, trades: 0, pnl: 0, wins: 0 }; item.trades += 1; item.pnl = round2(item.pnl + trade.pnl); if (trade.pnl > 0) item.wins += 1; hours.set(key, item); }
  const buckets = ["≤ -1R", "-1R to 0", "0 to 1R", "1R to 2R", "≥ 2R"];
  const bucketOf = (r: number) => (r <= -1 ? 0 : r < 0 ? 1 : r < 1 ? 2 : r < 2 ? 3 : 4);
  const rDistribution = buckets.map((bucket) => ({ bucket, count: 0 }));
  for (const trade of trades) rDistribution[bucketOf(trade.rMultiple)].count += 1;
  const dailyPnls = daily.map((item) => item.pnl);
  const capital = Math.max(1, settings.capital);
  const notes = [
    settings.pnlMode === "OPTION"
      ? `Option P&L is an estimate: index points × delta ${settings.delta} − ${settings.thetaPerDay} pts/day time decay − ₹${settings.chargesPerTrade} charges. Historical option premiums, IV changes and gamma are not replayed.`
      : `P&L in index points × ${settings.lots * settings.lotSize} units − ₹${settings.chargesPerTrade} charges (futures-like).`,
    "Signals use only candles completed at decision time; entries fill at the next 1-minute open with slippage; when a bar touches both stop and target, the stop is assumed first.",
  ];
  return {
    strategy: args.strategy, symbol: args.symbol, from: args.from, to: args.to, settings, trades,
    metrics: {
      trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? round2(wins.length / trades.length * 100) : 0,
      netPnl: round2(netPnl), grossProfit: round2(grossProfit), grossLoss: round2(grossLoss), profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
      expectancy: trades.length ? round2(netPnl / trades.length) : 0, expectancyR: trades.length ? round2(trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length) : 0,
      averageWin: wins.length ? round2(grossProfit / wins.length) : 0, averageLoss: losses.length ? round2(-grossLoss / losses.length) : 0,
      largestWin: wins.length ? Math.max(...wins.map((trade) => trade.pnl)) : 0, largestLoss: losses.length ? Math.min(...losses.map((trade) => trade.pnl)) : 0,
      maxDrawdown: round2(maxDrawdown), maxDrawdownPct: round2(maxDrawdown / capital * 100), averageHoldMinutes: trades.length ? Math.round(trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length) : 0,
      bestDay: dailyPnls.length ? Math.max(...dailyPnls) : 0, worstDay: dailyPnls.length ? Math.min(...dailyPnls) : 0, tradingDays: daily.length, profitableDays: daily.filter((item) => item.pnl > 0).length,
      maxConsecutiveLosses: maxStreak, totalCharges: round2(trades.length * settings.chargesPerTrade), returnPct: round2(netPnl / capital * 100),
    },
    equity: curve, daily, exitReasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    byHour: [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour)).map((item) => ({ hour: item.hour, trades: item.trades, pnl: item.pnl, winRate: round2(item.wins / item.trades * 100) })),
    rDistribution, skipped: args.skipped.sort((a, b) => a.day.localeCompare(b.day)), signalsSeen: args.signalsSeen, notes,
  };
}
