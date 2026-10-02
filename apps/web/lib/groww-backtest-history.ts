import type { Bar } from "../../../services/ai-monitoring/src/mtf-decision-engine";
import type { GrowwTransport } from "../../../adapters/groww/src/groww-adapter";

/**
 * Groww's backtesting candles API (`/v1/historical/candles`). Unlike the older
 * `/v1/historical/candle/range` endpoint, which only serves intraday candles for the last three
 * months, this one serves index/equity/F&O candles back to 2020, which is what a multi-month
 * backtest needs. Requests are made in 7-day windows, the smallest per-request cap Groww applies
 * to 1-minute candles.
 */
export const GROWW_INDEX_SYMBOLS: Record<string, { exchange: "NSE" | "BSE"; growwSymbol: string }> = {
  NIFTY: { exchange: "NSE", growwSymbol: "NSE-NIFTY" },
  BANKNIFTY: { exchange: "NSE", growwSymbol: "NSE-BANKNIFTY" },
  SENSEX: { exchange: "BSE", growwSymbol: "BSE-SENSEX" },
};

export const CHUNK_DAYS = 7;
const DAY_MS = 86_400_000;
const IST_S = 330 * 60;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Candle timestamps arrive as epoch seconds, epoch millis, or an IST wall-clock string. */
export function parseCandleTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : value;
  if (typeof value !== "string" || !value) return null;
  if (/^\d+$/.test(value)) return parseCandleTime(Number(value));
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const parsed = Date.parse(hasZone ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000) - (hasZone ? 0 : IST_S);
}

export function parseBacktestCandles(body: unknown): Bar[] {
  const payload = ((body as { payload?: unknown })?.payload ?? body) as { candles?: unknown[] };
  const rows = Array.isArray(payload?.candles) ? payload.candles : [];
  return rows.flatMap((row): Bar[] => {
    const cells = Array.isArray(row) ? row : row && typeof row === "object" ? (() => { const item = row as Record<string, unknown>; return [item.timestamp ?? item.time, item.open, item.high, item.low, item.close, item.volume]; })() : null;
    if (!cells || cells.length < 5) return [];
    const time = parseCandleTime(cells[0]);
    const [open, high, low, close] = cells.slice(1, 5).map(Number);
    if (time === null || ![open, high, low, close].every(Number.isFinite)) return [];
    const volume = Number(cells[5]);
    return [{ time, open, high, low, close, volume: Number.isFinite(volume) && volume > 0 ? volume : null }];
  });
}

export function weekChunks(from: string, to: string) {
  const chunks: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start = addDays(start, CHUNK_DAYS)) {
    const end = addDays(start, CHUNK_DAYS - 1);
    chunks.push({ from: start, to: end < to ? end : to });
  }
  return chunks;
}

export async function fetchGrowwBacktestMinutes(transport: GrowwTransport, symbol: string, from: string, to: string): Promise<Bar[]> {
  const market = GROWW_INDEX_SYMBOLS[symbol];
  if (!market) throw new Error(`No Groww backtesting symbol for ${symbol}`);
  const query = new URLSearchParams({ exchange: market.exchange, segment: "CASH", groww_symbol: market.growwSymbol, start_time: `${from} 09:15:00`, end_time: `${to} 15:30:00`, candle_interval: "1minute" });
  return parseBacktestCandles(await transport.request(`/v1/historical/candles?${query.toString()}`, { method: "GET" }));
}
