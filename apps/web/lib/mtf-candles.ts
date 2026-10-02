import type { Bar, TimeframeKey } from "../../../services/ai-monitoring/src/mtf-decision-engine";
import { istDate } from "./market-intel";

/**
 * Real 1D / 15m / 5m / 1m candles for the multi-timeframe engine (not 5m resampled into 15m).
 * Intraday index candles carry near-month futures volume so VWAP is a true VWAP, and delayed
 * intraday (Yahoo fallback) data is rejected: a stale chart must never drive an entry.
 */
const REQUESTS: Record<TimeframeKey, string> = {
  "1D": "timeframe=1D&period=year",
  "15m": "timeframe=15m&period=month&volume=futures",
  "5m": "timeframe=5m&period=week&volume=futures",
  "1m": "timeframe=1m&period=day&volume=futures",
};

export type MtfCandleSet = { candles: Partial<Record<TimeframeKey, Bar[]>>; issues: string[] };

export async function fetchMtfCandles(symbol: string, origin: string, fetcher: typeof fetch = fetch): Promise<MtfCandleSet> {
  const issues: string[] = [];
  const entries = await Promise.all((Object.keys(REQUESTS) as TimeframeKey[]).map(async (timeframe) => {
    try {
      const response = await fetcher(`${origin}/api/market-data/history?provider=groww&symbol=${encodeURIComponent(symbol)}&${REQUESTS[timeframe]}&date=${istDate()}`, { cache: "no-store" });
      const body = await response.json() as { candles?: Array<Record<string, unknown>>; delayed?: boolean; error?: string };
      if (!response.ok || !Array.isArray(body.candles)) { issues.push(`${timeframe}: ${body.error ?? `HTTP ${response.status}`}`); return [timeframe, []] as const; }
      // Completed daily bars are unaffected by a 15-minute delay; intraday bars are not usable delayed.
      if (body.delayed && timeframe !== "1D") { issues.push(`${timeframe}: only delayed data is available, ignored`); return [timeframe, []] as const; }
      const bars: Bar[] = body.candles
        .map((candle) => ({ time: Number(candle.time), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: candle.volume === null || candle.volume === undefined ? null : Number(candle.volume) }))
        .filter((bar) => Number.isFinite(bar.time) && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
      return [timeframe, bars] as const;
    } catch (error) {
      issues.push(`${timeframe}: ${error instanceof Error ? error.message : "request failed"}`);
      return [timeframe, []] as const;
    }
  }));
  return { candles: Object.fromEntries(entries), issues };
}
