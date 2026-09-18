import { NextResponse } from "next/server";
import { GrowwAdapter, createGrowwTransport } from "../../../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../../../adapters/groww/src/groww-instruments";

const symbols: Record<string, string> = { NIFTY: "NIFTY", BANKNIFTY: "BANKNIFTY", SENSEX: "SENSEX" };
const intervals: Record<string, number> = { "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "1h": 60, "4h": 240, "1D": 1440, "1W": 10080, "1M": 43200 };
const periods = ["day", "week", "month", "year"] as const;
type HistoryPeriod = typeof periods[number];

type HistoricalCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function rangeFor(period: HistoryPeriod, selectedDate: string) {
  const end = new Date(`${selectedDate}T23:59:59`);
  if (Number.isNaN(end.getTime())) throw new Error("Invalid history date");
  const days = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365;
  return { start: new Date(end.getTime() - days * 24 * 60 * 60 * 1000), end };
}

function toGrowwDate(value: Date) { return value.toISOString().slice(0, 19).replace("T", " "); }

function parseCandles(value: unknown): HistoricalCandle[] {
  const payload = (value as { payload?: Record<string, unknown> })?.payload ?? value as Record<string, unknown>;
  const rows = (payload?.candles ?? payload?.data ?? []) as unknown[];
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const [time, open, high, low, close, volume] = row.map(Number);
    return Number.isFinite(time) && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close) ? [{ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }] : [];
  });
}

function aggregateMonthly(candles: HistoricalCandle[]): HistoricalCandle[] {
  const grouped = new Map<string, HistoricalCandle>();
  for (const candle of candles) {
    const date = new Date(candle.time * 1000);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    const current = grouped.get(key);
    if (!current) grouped.set(key, { ...candle });
    else {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
    }
  }
  return [...grouped.values()].sort((left, right) => left.time - right.time);
}

async function fetchGrowwHistory(symbol: string, timeframe: string, period: HistoryPeriod, selectedDate: string) {
  const growwPeriod: HistoryPeriod = timeframe === "1m" ? "day" : timeframe === "3m" || timeframe === "5m" ? "week" : timeframe === "10m" || timeframe === "15m" ? "month" : period;
  const { start, end } = rangeFor(growwPeriod, selectedDate);
  const transport = createGrowwTransport();
  const responseInterval = timeframe === "1M" ? "1W" : timeframe;
  const catalog = await loadGrowwInstrumentCatalog();
  const instrument = catalog.getByTradingSymbol(symbol === "SENSEX" ? "BSE" : "NSE", symbol);
  const tradingSymbol = instrument?.tradingSymbol ?? symbols[symbol] ?? symbol;
  const exchange = instrument?.exchange ?? (symbol === "SENSEX" ? "BSE" : "NSE");
  const response = await transport.request(`/v1/historical/candle/range?exchange=${exchange}&segment=CASH&trading_symbol=${encodeURIComponent(tradingSymbol)}&start_time=${encodeURIComponent(toGrowwDate(start))}&end_time=${encodeURIComponent(toGrowwDate(end))}&interval_in_minutes=${intervals[responseInterval]}`, { method: "GET" });
  const candles = parseCandles(response);
  return timeframe === "1M" ? aggregateMonthly(candles) : candles;
}

async function fetchYahooHistory(symbol: string, timeframe: string, period: HistoryPeriod, selectedDate: string) {
  const ticker = { NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", SENSEX: "^BSESN" }[symbol as "NIFTY" | "BANKNIFTY" | "SENSEX"] ?? symbol;
  const interval = timeframe === "1M" ? "1mo" : timeframe === "1W" ? "1wk" : timeframe === "1D" ? "1d" : timeframe === "4h" ? "60m" : timeframe === "1h" ? "60m" : timeframe === "10m" || timeframe === "3m" ? "5m" : timeframe === "1m" ? "1m" : "15m";
  const intraday = ["1m", "3m", "5m", "10m", "15m", "1h", "4h"].includes(timeframe);
  const range = intraday ? (timeframe === "1m" ? "5d" : "1mo") : period === "day" ? "1d" : period === "week" ? "5d" : period === "month" ? "1mo" : "1y";
  const requestedEnd = new Date(`${selectedDate}T23:59:59`);
  const end = requestedEnd > new Date() ? new Date() : requestedEnd;
  const period2 = Math.floor(end.getTime() / 1000);
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}&period2=${period2}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Yahoo historical data ${response.status}`);
  const result = (await response.json()).chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  return timestamps.flatMap((time: number, index: number) => { const open = Number(quote.open?.[index]); const high = Number(quote.high?.[index]); const low = Number(quote.low?.[index]); const close = Number(quote.close?.[index]); if (![open, high, low, close].every(Number.isFinite)) return []; return [{ time, open, high, low, close, volume: Number(quote.volume?.[index] ?? 0) }]; });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const timeframe = url.searchParams.get("timeframe") ?? "5m";
  const period = (url.searchParams.get("period") ?? "day") as HistoryPeriod;
  const selectedDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const provider = url.searchParams.get("provider") ?? process.env.MARKET_DATA_PROVIDER ?? "groww";
  const validEquitySymbol = /^[A-Z][A-Z0-9.&_-]{0,29}$/.test(symbol);
  if (!validEquitySymbol || !intervals[timeframe] || !periods.includes(period)) return NextResponse.json({ error: "Unsupported symbol, timeframe, or period" }, { status: 400 });
  try {
    if (provider === "groww") {
      try {
        const candles = await fetchGrowwHistory(symbol, timeframe, period, selectedDate);
        return NextResponse.json({ candles, provider: "groww", source: `Groww historical candles (${period}, ${selectedDate})`, delayed: false, symbol, timeframe, period, date: selectedDate });
      } catch (error) {
        const candles = await fetchYahooHistory(symbol, timeframe, period, selectedDate);
        return NextResponse.json({ candles, provider: "yahoo", requestedProvider: "groww", source: `Yahoo Finance fallback after Groww failure${error instanceof Error ? `: ${error.message}` : ""}`, delayed: true, symbol, timeframe, period, date: selectedDate });
      }
    }
    if (provider === "fallback") return NextResponse.json({ candles: [], provider, source: "Fallback fixture", delayed: true, symbol, timeframe, period, date: selectedDate });
    const candles = await fetchYahooHistory(symbol, timeframe, period, selectedDate);
    return NextResponse.json({ candles, provider: "yahoo", source: `Yahoo Finance historical data (${period}, ${selectedDate})`, delayed: true, symbol, timeframe, period, date: selectedDate });
  } catch (error) {
    if (provider === "groww") {
      return NextResponse.json({ candles: [], provider: "groww", source: "Groww historical data unavailable", delayed: false, symbol, timeframe, period, date: selectedDate, error: error instanceof Error ? error.message : "Groww historical data unavailable" }, { status: 503 });
    }
    try { const candles = await fetchYahooHistory(symbol, timeframe, period, selectedDate); return NextResponse.json({ candles, provider: "yahoo", requestedProvider: provider, source: `Yahoo Finance fallback${error instanceof Error ? `: ${error.message}` : ""}`, delayed: true, symbol, timeframe, period, date: selectedDate }); }
    catch { return NextResponse.json({ candles: [], provider: "fallback", requestedProvider: provider, source: "Historical data unavailable", delayed: true, symbol, timeframe, period, date: selectedDate }); }
  }
}