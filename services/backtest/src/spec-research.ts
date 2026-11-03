import type { Bar } from "../../ai-monitoring/src/mtf-decision-engine";
import { istDay, istMinute, runBacktest, type BacktestMetrics, type BacktestSettings, type Signal, type StrategyId } from "./strategy-backtest";

/**
 * Research tooling around a backtest (spec v1.0 sections 3, 10–12): input validation with a
 * data-quality report, one-at-a-time sensitivity tests, the simple baselines the spec asks for, and a
 * provenance record so a result can be reproduced.
 */

export type DataQuality = {
  bars: number; duplicates: number; invalidOhlc: number; outOfOrder: boolean;
  /** 1-minute bars missing inside the 09:15–15:29 sessions of the tested range (never forward-filled). */
  missingMinutes: number; sessionsWithGaps: number; zeroVolumeSessions: number; sessions: number;
  warnings: string[];
};

/**
 * Sort ascending, resolve duplicate timestamps deterministically (the first one received is kept),
 * drop candles whose OHLC is inconsistent, and count missing minutes per session. Nothing is filled.
 */
export function validateMinuteBars(input: Bar[], from: string, to: string): { bars: Bar[]; quality: DataQuality } {
  const outOfOrder = input.some((bar, index) => index > 0 && input[index - 1].time > bar.time);
  const sorted = outOfOrder ? input.map((bar, order) => ({ bar, order })).sort((a, b) => a.bar.time - b.bar.time || a.order - b.order).map((item) => item.bar) : input;
  const seen = new Set<number>();
  let duplicates = 0; let invalidOhlc = 0;
  const bars: Bar[] = [];
  for (const bar of sorted) {
    if (seen.has(bar.time)) { duplicates += 1; continue; }
    seen.add(bar.time);
    const ok = [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)
      && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close) && (bar.volume === null || bar.volume === undefined || bar.volume >= 0);
    if (!ok) { invalidOhlc += 1; continue; }
    bars.push(bar);
  }
  const perDay = new Map<string, { count: number; volume: number }>();
  for (const bar of bars) {
    const day = istDay(bar.time);
    if (day < from || day > to) continue;
    const minute = istMinute(bar.time);
    if (minute < 9 * 60 + 15 || minute > 15 * 60 + 29) continue;
    const item = perDay.get(day) ?? { count: 0, volume: 0 };
    item.count += 1; item.volume += bar.volume ?? 0;
    perDay.set(day, item);
  }
  let missingMinutes = 0; let sessionsWithGaps = 0; let zeroVolumeSessions = 0;
  const gapDays: string[] = [];
  for (const [day, item] of perDay) {
    const missing = Math.max(0, 375 - item.count);
    missingMinutes += missing;
    if (missing > 0) { sessionsWithGaps += 1; if (gapDays.length < 8) gapDays.push(`${day} (${missing})`); }
    if (item.volume <= 0) zeroVolumeSessions += 1;
  }
  const warnings: string[] = [];
  if (outOfOrder) warnings.push("Candles arrived out of order; sorted ascending.");
  if (duplicates) warnings.push(`${duplicates} duplicate timestamp(s): the first candle received was kept.`);
  if (invalidOhlc) warnings.push(`${invalidOhlc} candle(s) with inconsistent OHLC (high below open/close, low above them, or non-positive) were dropped.`);
  if (missingMinutes) warnings.push(`${missingMinutes} one-minute candle(s) missing across ${sessionsWithGaps} session(s), not filled${gapDays.length ? `: ${gapDays.join(", ")}${sessionsWithGaps > gapDays.length ? ", …" : ""}` : ""}.`);
  if (zeroVolumeSessions) warnings.push(`${zeroVolumeSessions} of ${perDay.size} session(s) carry no volume (index candles): a volume-weighted VWAP is undefined there.`);
  return { bars, quality: { bars: bars.length, duplicates, invalidOhlc, outOfOrder, missingMinutes, sessionsWithGaps, zeroVolumeSessions, sessions: perDay.size, warnings } };
}

type SignalAt = (index: number, minute: Bar[]) => Signal | null;
export type SensitivityRow = {
  group: string; label: string; baseline: boolean;
  metrics: Pick<BacktestMetrics, "trades" | "winRate" | "netPnl" | "profitFactor" | "expectancyR" | "maxDrawdown" | "longTrades" | "shortTrades">;
};
const pick = (m: BacktestMetrics): SensitivityRow["metrics"] => ({ trades: m.trades, winRate: m.winRate, netPnl: m.netPnl, profitFactor: m.profitFactor, expectancyR: m.expectancyR, maxDrawdown: m.maxDrawdown, longTrades: m.longTrades, shortTrades: m.shortTrades });

/**
 * One-at-a-time sensitivity (section 11): each row changes one parameter from the current settings
 * on the same data. ADX 0 is the "no ADX filter" baseline. Timeframe rows use their own signals.
 */
export function specSensitivity(input: { strategy: StrategyId; symbol: string; from: string; to: string; minute: Bar[]; settings: BacktestSettings; signalsFor: (timeframe: 1 | 3 | 5) => SignalAt }): SensitivityRow[] {
  const { settings } = input;
  const run = (overrides: Partial<BacktestSettings>, signalAt = input.signalsFor(settings.specTimeframe)) =>
    pick(runBacktest({ strategy: input.strategy, symbol: input.symbol, from: input.from, to: input.to, minute: input.minute, signalAt, settings: { ...settings, ...overrides } }).metrics);
  const rows: SensitivityRow[] = [];
  const add = (group: string, label: string, baseline: boolean, metrics: SensitivityRow["metrics"]) => rows.push({ group, label, baseline, metrics });
  for (const value of [...new Set([0, 20, 25, 30, 35, settings.specAdxThreshold])].sort((a, b) => a - b))
    add("ADX threshold", value === 0 ? "No ADX filter (> 0)" : `ADX > ${value}`, value === settings.specAdxThreshold, run({ specAdxThreshold: value }));
  for (const value of [...new Set([10, 15, 20, 30, 40, settings.specRiskPoints])].sort((a, b) => a - b))
    add("Stop distance", `${value} pts`, value === settings.specRiskPoints, run({ specRiskPoints: value }));
  for (const value of [...new Set([1, 1.5, 2, 3, settings.specRewardMultiple])].sort((a, b) => a - b))
    add("Reward multiple", `${value}R`, value === settings.specRewardMultiple, run({ specRewardMultiple: value }));
  for (const value of [1, 3, 5] as const)
    add("Signal timeframe", `${value}-minute`, value === settings.specTimeframe, run({ specTimeframe: value }, input.signalsFor(value)));
  const windows: Array<[string, string]> = [[settings.entryStart, settings.entryEnd], ["09:20", "15:00"], ["09:30", "14:30"], ["09:45", "13:30"], ["10:00", "14:45"]];
  const seen = new Set<string>();
  for (const [start, end] of windows) {
    const key = `${start}-${end}`;
    if (seen.has(key) || !(start < end && end < settings.squareOff)) continue;
    seen.add(key);
    add("Entry window", `${start}–${end}`, start === settings.entryStart && end === settings.entryEnd, run({ entryStart: start, entryEnd: end }));
  }
  return rows;
}

/**
 * Intraday buy-and-hold baseline (section 12): every tested session, buy at the open of the bar after
 * the entry-window start and sell at the square-off, with the same slippage, charges and P&L model.
 */
export function intradayBuyAndHold(input: { symbol: string; from: string; to: string; minute: Bar[]; settings: BacktestSettings }) {
  const start = Number(input.settings.entryStart.slice(0, 2)) * 60 + Number(input.settings.entryStart.slice(3));
  const signalAt: SignalAt = (index, minute) => {
    const bar = minute[index];
    if (istMinute(bar.time + 60) !== start) return null;
    return { time: bar.time + 60, side: 1, stop: 0, target1: Number.MAX_SAFE_INTEGER, management: "FIXED_POINTS", confidence: 100, strategy: "Intraday buy & hold", reason: "Baseline: long at the entry-window start, flat at the square-off" };
  };
  const result = runBacktest({ strategy: "VWAP_EMA_ADX_SPEC", symbol: input.symbol, from: input.from, to: input.to, minute: input.minute, signalAt,
    settings: { ...input.settings, specRiskPoints: 1e9, specRewardMultiple: 1, specEmaExit: false, maxTradesPerDay: 1, maxDailyLoss: 1e12, maxConsecutiveLosses: 1e6, cooldownMinutes: 0, minConfidence: 0 } });
  return pick(result.metrics);
}

/** FNV-1a fingerprint of the tested candles: the same data gives the same id. */
export function dataFingerprint(minute: Bar[], from: string, to: string) {
  let hash = 0x811c9dc5;
  const mix = (value: number) => { const text = String(value); for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; } };
  let count = 0;
  for (const bar of minute) {
    const day = istDay(bar.time);
    if (day < from || day > to) continue;
    count += 1;
    mix(bar.time); mix(bar.open); mix(bar.high); mix(bar.low); mix(bar.close); mix(bar.volume ?? 0);
  }
  return { bars: count, hash: hash.toString(16).padStart(8, "0") };
}
