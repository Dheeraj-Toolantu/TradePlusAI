import type { Bar } from "../../../services/ai-monitoring/src/mtf-decision-engine";
import { istDay } from "../../../services/backtest/src/strategy-backtest";
import { syntheticSessions } from "../../../services/backtest/src/synthetic-market";

export type BacktestSource = "groww" | "yahoo" | "synthetic";
export const BACKTEST_SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
export const MAX_BACKTEST_DAYS = 31;
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
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_BACKTEST_DAYS) return `Choose at most ${MAX_BACKTEST_DAYS} calendar days (1-minute history is fetched per day)`;
  return null;
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
 * 1-minute bars for every weekday in [from - warmup, to] (one history request per day: the provider
 * serves 1m candles a day at a time) and a year of daily bars for the 1D context.
 */
export async function loadBacktestData(args: { symbol: string; from: string; to: string; source: BacktestSource; origin: string; fetcher?: typeof fetch }) {
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
  const perDay = await pool(days, 4, async (day) => {
    try {
      const response = await fetcher(`${origin}/api/market-data/history?provider=${source}&symbol=${encodeURIComponent(symbol)}&timeframe=1m&period=day&volume=futures&date=${day}`, { cache: "no-store" });
      const body = await response.json() as { candles?: Array<Record<string, unknown>>; delayed?: boolean; error?: string };
      if (!response.ok || !Array.isArray(body.candles)) { if (day >= from) issues.push(`${day}: ${body.error ?? `HTTP ${response.status}`}`); return []; }
      if (body.delayed) delayed = true;
      const bars = body.candles.map(toBar).filter(valid).filter((bar) => istDay(bar.time) === day);
      if (!bars.length && day >= from) issues.push(`${day}: no 1-minute data (holiday or outside the provider's history window)`);
      return bars;
    } catch (error) {
      if (day >= from) issues.push(`${day}: ${error instanceof Error ? error.message : "request failed"}`);
      return [];
    }
  });
  let daily: Bar[] = [];
  try {
    const response = await fetcher(`${origin}/api/market-data/history?provider=${source}&symbol=${encodeURIComponent(symbol)}&timeframe=1D&period=year&date=${to}`, { cache: "no-store" });
    const body = await response.json() as { candles?: Array<Record<string, unknown>> };
    daily = Array.isArray(body.candles) ? body.candles.map(toBar).filter(valid) : [];
    if (!daily.length) issues.push("Daily (1D) history unavailable: the 1D context is skipped");
  } catch { issues.push("Daily (1D) history unavailable: the 1D context is skipped"); }
  const minute = perDay.flat().sort((a, b) => a.time - b.time);
  return { minute, daily, issues, provider: source, delayed, sessions: new Set(minute.filter((bar) => istDay(bar.time) >= from).map((bar) => istDay(bar.time))).size };
}
