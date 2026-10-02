import type { Bar } from "../../../services/ai-monitoring/src/mtf-decision-engine";
import { istDay } from "../../../services/backtest/src/strategy-backtest";
import { syntheticSessions } from "../../../services/backtest/src/synthetic-market";
import { createGrowwTransport, type GrowwTransport } from "../../../adapters/groww/src/groww-adapter";
import { fetchGrowwBacktestMinutes, weekChunks } from "./groww-backtest-history";

export type BacktestSource = "groww" | "yahoo" | "synthetic";
export const BACKTEST_SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
/** About six months; Groww's backtesting API serves 1-minute index candles back to 2020. */
export const MAX_BACKTEST_DAYS = 190;
/** Yahoo only keeps 1-minute candles for roughly the last 30 days. */
export const YAHOO_MINUTE_HISTORY_DAYS = 29;
/** Trading days loaded before `from` so EMAs, swings and the 15m trend are warm on day one. */
const WARMUP_WEEKDAYS = 3;

const DAY_MS = 86_400_000;
const isWeekday = (day: string) => { const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); return dow !== 0 && dow !== 6; };
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function validateRange(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return "Dates must be YYYY-MM-DD";
  if (to < from) return "End date must be on or after the start date";
  if (to > istToday()) return "End date cannot be in the future";
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_BACKTEST_DAYS) return `Choose at most ${MAX_BACKTEST_DAYS} calendar days (about six months)`;
  return null;
}

export function validateSourceRange(source: BacktestSource, from: string): string | null {
  if (source === "yahoo" && from < addDays(istToday(), -YAHOO_MINUTE_HISTORY_DAYS)) return `Yahoo only keeps 1-minute candles for the last ~30 days (from ${addDays(istToday(), -YAHOO_MINUTE_HISTORY_DAYS)}). Use Groww history for older or longer periods.`;
  return null;
}

/** "2026-06-03 → 2026-06-05, 2026-06-08" style ranges of consecutive weekdays. */
export function compactDays(days: string[]) {
  const sorted = [...days].sort();
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const first = sorted[index];
    let last = first;
    while (index + 1 < sorted.length) {
      let gap = addDays(last, 1);
      while (!isWeekday(gap)) gap = addDays(gap, 1);
      if (sorted[index + 1] !== gap) break;
      last = sorted[++index];
    }
    parts.push(first === last ? first : `${first} → ${last}`);
  }
  return parts.join(", ");
}

function warmupStart(from: string) {
  let day = from; let found = 0;
  while (found < WARMUP_WEEKDAYS) { day = addDays(day, -1); if (isWeekday(day)) found += 1; }
  return day;
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await worker(items[index]); } }));
  return results;
}

const toBar = (candle: Record<string, unknown>): Bar => ({ time: Number(candle.time), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: candle.volume === null || candle.volume === undefined ? null : Number(candle.volume) });
const valid = (bar: Bar) => Number.isFinite(bar.time) && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite);

/**
 * 1-minute bars for every weekday in [from - warmup, to] and a year of daily bars for the 1D context.
 * Groww: the backtesting API in 7-day windows (history back to 2020), falling back per day to the
 * older history route. Yahoo: one request per day (Yahoo keeps ~30 days of 1-minute candles).
 */
export async function loadBacktestData(args: { symbol: string; from: string; to: string; source: BacktestSource; origin: string; fetcher?: typeof fetch; growwTransport?: GrowwTransport }) {
  const { symbol, from, to, source, origin } = args;
  const start = warmupStart(from);
  if (source === "synthetic") {
    const { minute, daily } = syntheticSessions(addDays(from, -90), to, { seed: symbol.length * 97 + Date.parse(from) / DAY_MS });
    return { minute: minute.filter((bar) => istDay(bar.time) >= start), daily, issues: [] as string[], provider: "synthetic", delayed: false, sessions: [...new Set(minute.filter((bar) => istDay(bar.time) >= from).map((bar) => istDay(bar.time)))].length };
  }
  const fetcher = args.fetcher ?? fetch;
  const days: string[] = [];
  for (let day = start; day <= to; day = addDays(day, 1)) if (isWeekday(day)) days.push(day);
  const issues: string[] = [];
  let delayed = false;
  let provider: string = source;

  // Older per-day route (Groww's /candle/range keeps intraday candles ~3 months; Yahoo ~30 days).
  const perDayRoute = async (day: string): Promise<Bar[]> => {
    try {
      const response = await fetcher(`${origin}/api/market-data/history?provider=${source}&symbol=${encodeURIComponent(symbol)}&timeframe=1m&period=day&volume=futures&date=${day}`, { cache: "no-store" });
      const body = await response.json() as { candles?: Array<Record<string, unknown>>; delayed?: boolean; error?: string };
      if (!response.ok || !Array.isArray(body.candles)) { if (day >= from && body.error) issues.push(`${day}: ${body.error}`); return []; }
      if (body.delayed) delayed = true;
      return body.candles.map(toBar).filter(valid).filter((bar) => istDay(bar.time) === day);
    } catch (error) {
      if (day >= from) issues.push(`${day}: ${error instanceof Error ? error.message : "request failed"}`);
      return [];
    }
  };

  let bars: Bar[];
  if (source === "groww") {
    const transport = args.growwTransport ?? createGrowwTransport();
    let backtestApiFailures = 0;
    const chunks = await pool(weekChunks(start, to), 2, async (chunk) => {
      try {
        const candles = await fetchGrowwBacktestMinutes(transport, symbol, chunk.from, chunk.to);
        if (candles.length) return candles.filter((bar) => { const day = istDay(bar.time); return day >= chunk.from && day <= chunk.to; });
      } catch (error) {
        backtestApiFailures += 1;
        if (backtestApiFailures === 1) issues.push(`Groww backtesting API unavailable (${error instanceof Error ? error.message : "request failed"}); fell back to the per-day history route, which only covers the last ~3 months.`);
      }
      const fallbackDays = days.filter((day) => day >= chunk.from && day <= chunk.to);
      return (await pool(fallbackDays, 4, perDayRoute)).flat();
    });
    bars = chunks.flat();
    provider = backtestApiFailures ? "groww (partly per-day route)" : "groww";
  } else {
    bars = (await pool(days, 4, perDayRoute)).flat();
  }
  const seen = new Set<number>();
  const minute = bars.filter((bar) => (seen.has(bar.time) ? false : (seen.add(bar.time), true))).sort((a, b) => a.time - b.time);
  const covered = new Set(minute.map((bar) => istDay(bar.time)));
  const missing = days.filter((day) => day >= from && !covered.has(day));
  if (missing.length) issues.unshift(`No 1-minute candles for ${missing.length} weekday${missing.length === 1 ? "" : "s"} (exchange holidays, or outside the provider's history): ${compactDays(missing)}`);
  let daily: Bar[] = [];
  try {
    const response = await fetcher(`${origin}/api/market-data/history?provider=${source}&symbol=${encodeURIComponent(symbol)}&timeframe=1D&period=year&date=${to}`, { cache: "no-store" });
    const body = await response.json() as { candles?: Array<Record<string, unknown>> };
    daily = Array.isArray(body.candles) ? body.candles.map(toBar).filter(valid) : [];
    if (!daily.length) issues.push("Daily (1D) history unavailable: the 1D context is skipped");
  } catch { issues.push("Daily (1D) history unavailable: the 1D context is skipped"); }
  return { minute, daily, issues, provider, delayed, sessions: new Set(minute.filter((bar) => istDay(bar.time) >= from).map((bar) => istDay(bar.time))).size };
}
