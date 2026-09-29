import { NextResponse } from "next/server";
import { GrowwAdapter, createGrowwTransport } from "../../../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../../../adapters/groww/src/groww-instruments";

const symbols: Record<string, string> = { NIFTY: "NIFTY", BANKNIFTY: "BANKNIFTY", SENSEX: "SENSEX" };
const intervals: Record<string, number> = { "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "1h": 60, "4h": 240, "1D": 1440, "1W": 10080, "1M": 43200 };
const periods = ["day", "week", "month", "year"] as const;
type HistoryPeriod = typeof periods[number];

type HistoricalCandle = { time: number; open: number; high: number; low: number; close: number; volume: number | null };

function rangeFor(period: HistoryPeriod, selectedDate: string) {
  const end = new Date(`${selectedDate}T23:59:59`);
  if (Number.isNaN(end.getTime())) throw new Error("Invalid history date");
  const days = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365;
  return { start: new Date(end.getTime() - days * 24 * 60 * 60 * 1000), end };
}

function toGrowwDate(value: Date) { return value.toISOString().slice(0, 19).replace("T", " "); }
function numericVolume(value: unknown) { if (value === null || value === undefined || value === "") return null; const volume = Number(value); return Number.isFinite(volume) && volume >= 0 ? volume : null; }

function parseCandles(value: unknown): HistoricalCandle[] {
  const payload = (value as { payload?: Record<string, unknown> })?.payload ?? value as Record<string, unknown>;
  const rows = (payload?.candles ?? payload?.data ?? []) as unknown[];
  return rows.flatMap((row) => {
    if (Array.isArray(row)) {
      if (row.length < 5) return [];
      const [time, open, high, low, close, volume] = row.map(Number);
      return Number.isFinite(time) && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close) ? [{ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : null }] : [];
    }
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const time = Number(item.time ?? item.timestamp ?? item.t ?? item.start_time);
    const open = Number(item.open ?? item.open_price);
    const high = Number(item.high ?? item.high_price);
    const low = Number(item.low ?? item.low_price);
    const close = Number(item.close ?? item.close_price ?? item.ltp);
    const volume = Number(item.volume ?? item.vol ?? item.total_volume);
    return Number.isFinite(time) && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close) ? [{ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : null }] : [];
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

const FUTURES_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "SENSEX"]);
const INTRADAY = new Set(["1m", "3m", "5m", "10m", "15m", "1h"]);

/**
 * Index candles have no traded volume. Volume evidence (VWAP weighting, the V5 1.5x volume
 * expansion score) uses the near-month futures contract instead, matched candle-by-candle.
 * On expiry day the next month is used, since volume has already rolled.
 */
async function attachFuturesVolume(symbol: string, candles: HistoricalCandle[], interval: number, start: Date, end: Date, selectedDate: string) {
  const catalog = await loadGrowwInstrumentCatalog();
  const future = catalog.getAll()
    .filter((instrument) => instrument.segment === "FNO" && instrument.instrumentType === "FUT" && instrument.underlyingSymbol === symbol && Boolean(instrument.expiryDate) && instrument.expiryDate! > selectedDate)
    .sort((left, right) => String(left.expiryDate).localeCompare(String(right.expiryDate)))[0];
  if (!future) return null;
  const response = await createGrowwTransport().request(`/v1/historical/candle/range?exchange=${future.exchange}&segment=FNO&trading_symbol=${encodeURIComponent(future.tradingSymbol)}&start_time=${encodeURIComponent(toGrowwDate(start))}&end_time=${encodeURIComponent(toGrowwDate(end))}&interval_in_minutes=${interval}`, { method: "GET" });
  const volumes = new Map(parseCandles(response).map((candle) => [candle.time, candle.volume ?? 0]));
  if (![...volumes.values()].some((volume) => volume > 0)) return null;
  for (let index = 0; index < candles.length; index += 1) candles[index] = { ...candles[index], volume: volumes.get(candles[index].time) ?? 0 };
  return future.tradingSymbol;
}

async function fetchGrowwHistory(symbol: string, timeframe: string, period: HistoryPeriod, selectedDate: string, withFuturesVolume = false) {
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
  // The whole-day cumulative quote volume used to be written into the last candle here. That
  // made one 5-minute bar carry the entire session's volume, which skewed VWAP to that bar and
  // made every volume-expansion check pass or fail at random. Use futures volume instead.
  let volumeSource: string | null = candles.some((candle) => candle.volume !== null && candle.volume > 0) ? "INSTRUMENT" : null;
  if (!volumeSource && withFuturesVolume && FUTURES_UNDERLYINGS.has(symbol) && INTRADAY.has(timeframe) && candles.length) {
    try {
      const contract = await attachFuturesVolume(symbol, candles, intervals[responseInterval], start, end, selectedDate);
      if (contract) volumeSource = `NEAR_MONTH_FUTURES:${contract}`;
    } catch { /* volume stays unavailable; the V5 volume score then fails closed */ }
  }
  return { candles: timeframe === "1M" ? aggregateMonthly(candles) : candles, volumeSource };
}

async function fetchYahooHistory(symbol: string, timeframe: string, period: HistoryPeriod, selectedDate: string) {
  const ticker = { NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", SENSEX: "^BSESN" }[symbol as "NIFTY" | "BANKNIFTY" | "SENSEX"] ?? symbol;
  const interval = timeframe === "1M" ? "1mo" : timeframe === "1W" ? "1wk" : timeframe === "1D" ? "1d" : timeframe === "4h" ? "60m" : timeframe === "1h" ? "60m" : timeframe === "5m" || timeframe === "10m" || timeframe === "3m" ? "5m" : timeframe === "1m" ? "1m" : "15m";
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
  return timestamps.flatMap((time: number, index: number) => { const open = Number(quote.open?.[index]); const high = Number(quote.high?.[index]); const low = Number(quote.low?.[index]); const close = Number(quote.close?.[index]); if (![open, high, low, close].every(Number.isFinite)) return []; return [{ time, open, high, low, close, volume: numericVolume(quote.volume?.[index]) }]; });
}

// Short response cache: the algo page, market-intel and the V5 engine all request the same
// 5-minute history within seconds of each other. Only successful responses are cached.
const HISTORY_TTL_MS = 20_000;
const historyGlobal = globalThis as typeof globalThis & { __tradepulseHistoryCache?: Map<string, { at: number; body: unknown }> };
const historyCache = (historyGlobal.__tradepulseHistoryCache ??= new Map());

export async function GET(request: Request) {
  const key = new URL(request.url).search;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return NextResponse.json(cached.body);
  const response = await computeHistory(request);
  if (response.status === 200) {
    const body = await response.clone().json();
    if (historyCache.size > 200) historyCache.clear();
    historyCache.set(key, { at: Date.now(), body });
  }
  return response;
}

async function computeHistory(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const timeframe = url.searchParams.get("timeframe") ?? "5m";
  const period = (url.searchParams.get("period") ?? "day") as HistoryPeriod;
  const selectedDate = url.searchParams.get("date") ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const withFuturesVolume = url.searchParams.get("volume") === "futures";
  const provider = url.searchParams.get("provider") ?? process.env.MARKET_DATA_PROVIDER ?? "groww";
  const validEquitySymbol = /^[A-Z][A-Z0-9.&_-]{0,29}$/.test(symbol);
  if (!validEquitySymbol || !intervals[timeframe] || !periods.includes(period)) return NextResponse.json({ error: "Unsupported symbol, timeframe, or period" }, { status: 400 });
  try {
    if (provider === "groww") {
      try {
        const { candles, volumeSource } = await fetchGrowwHistory(symbol, timeframe, period, selectedDate, withFuturesVolume);
        return NextResponse.json({ candles, provider: "groww", source: `Groww historical candles (${period}, ${selectedDate})`, volumeAvailable: volumeSource !== null, volumeSource, delayed: false, symbol, timeframe, period, date: selectedDate });
      } catch (error) {
        const candles = await fetchYahooHistory(symbol, timeframe, period, selectedDate);
        return NextResponse.json({ candles, provider: "yahoo", requestedProvider: "groww", source: `Yahoo Finance fallback after Groww failure${error instanceof Error ? `: ${error.message}` : ""}`, volumeAvailable: candles.some((candle) => candle.volume !== null && candle.volume > 0), delayed: true, symbol, timeframe, period, date: selectedDate });
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