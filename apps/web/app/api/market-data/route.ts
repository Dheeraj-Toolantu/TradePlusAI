import { NextResponse } from "next/server";
import { GrowwAdapter, createGrowwTransport } from "../../../../../adapters/groww/src/groww-adapter";

const symbols: Record<string, string> = { NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", SENSEX: "^BSESN", "INDIA VIX": "^INDIAVIX" };
const fallback = { NIFTY: { price: 24871.3, change: 128.45, percent: 0.52 }, BANKNIFTY: { price: 54238.6, change: 312.75, percent: 0.58 }, SENSEX: { price: 81362.11, change: 421.32, percent: 0.52 }, "INDIA VIX": { price: 12.68, change: -0.41, percent: -3.13 } };

async function fetchQuote(symbol: string) {
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbols[symbol])}?range=1d&interval=5m`, { next: { revalidate: 30 } });
    if (!response.ok) throw new Error("provider unavailable");
    const result = (await response.json()).chart?.result?.[0];
    const meta = result?.meta;
    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((value: number | null): value is number => value !== null);
    const price = Number(meta?.regularMarketPrice ?? closes.at(-1));
    const previous = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    const change = price - previous;
    return { symbol, price, change, percent: previous ? (change / previous) * 100 : 0, previousClose: previous, open: Number(meta?.regularMarketOpen ?? meta?.open ?? price), high: Number(meta?.regularMarketDayHigh ?? meta?.dayHigh ?? price), low: Number(meta?.regularMarketDayLow ?? meta?.dayLow ?? price), volume: Number(meta?.regularMarketVolume ?? meta?.volume ?? 0), marketState: meta?.marketState ?? "REGULAR", providerTimestamp: meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null, closes, source: "Yahoo Finance delayed market data" };
  } catch {
    const item = fallback[symbol as keyof typeof fallback];
    return { symbol, ...item, previousClose: item.price - item.change, open: item.price, high: item.price, low: item.price, volume: 0, marketState: "UNKNOWN", providerTimestamp: null, closes: [], source: "Fallback fixture (provider unavailable)" };
  }
}

async function fetchGrowwQuotes(selected: string[]) {
  const adapter = new GrowwAdapter(createGrowwTransport());
  const result = await adapter.getQuotes(selected);
  if ("error" in result) throw new Error(result.error.message);
  return result.value.map((quote) => ({ ...quote, previousClose: quote.price - (quote.change ?? 0), open: quote.price, high: quote.price, low: quote.price, volume: 0, marketState: "REAL_TIME", providerTimestamp: quote.timestamp, closes: [quote.price], source: "Groww real-time market data" }));
}

type MarketDataProvider = "groww" | "yahoo" | "fallback";

function requestedProvider(value: string | null): MarketDataProvider {
  if (value === "groww" || value === "yahoo" || value === "fallback") return value;
  const configured = process.env.MARKET_DATA_PROVIDER;
  return configured === "groww" || configured === "yahoo" || configured === "fallback" ? configured : "yahoo";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const selected = (url.searchParams.get("symbols") ?? Object.keys(symbols).join(",")).split(",").map((item) => item.trim().toUpperCase()).filter((item) => symbols[item]);
  const provider = requestedProvider(url.searchParams.get("provider"));
  const growwConfigured = Boolean(process.env.GROWW_ACCESS_TOKEN || (process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET));
  try {
    if (provider === "groww" && !growwConfigured) throw new Error("Groww is not configured on the server");
    if (provider === "groww") return NextResponse.json({ quotes: await fetchGrowwQuotes(selected), updatedAt: new Date().toISOString(), delayed: false, provider, source: "Groww real-time market data" });
    if (provider === "fallback") {
      const quotes = selected.map((symbol) => { const item = fallback[symbol as keyof typeof fallback]; return { symbol, ...item, previousClose: item.price - item.change, open: item.price, high: item.price, low: item.price, volume: 0, marketState: "SIMULATED", providerTimestamp: null, closes: [], source: "Fallback fixture" }; });
      return NextResponse.json({ quotes, updatedAt: new Date().toISOString(), delayed: true, provider, source: "Fallback fixture" });
    }
    const quotes = await Promise.all(selected.map(fetchQuote));
    return NextResponse.json({ quotes, updatedAt: new Date().toISOString(), delayed: true, provider, source: "Yahoo Finance delayed market data" });
  } catch (error) {
    if (provider === "groww") {
      return NextResponse.json({ quotes: [], updatedAt: new Date().toISOString(), delayed: false, provider: "groww", source: "Groww real-time market data unavailable", error: error instanceof Error ? error.message : "Groww market data unavailable" }, { status: 503 });
    }
    const quotes = await Promise.all(selected.map(fetchQuote));
    return NextResponse.json({ quotes, updatedAt: new Date().toISOString(), delayed: true, provider: "yahoo", requestedProvider: provider, source: `Yahoo Finance fallback${error instanceof Error ? `: ${error.message}` : ""}` });
  }
}