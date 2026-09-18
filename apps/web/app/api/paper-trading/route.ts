import { NextResponse } from "next/server";
import { GrowwAdapter, createGrowwTransport } from "../../../../../adapters/groww/src/groww-adapter";
import { AutoPaperTrader } from "../../../../../services/paper-trading/src/auto-paper-trader";

const trader = new AutoPaperTrader();
const symbols = ["NIFTY", "BANKNIFTY", "SENSEX"];

export async function GET() { return NextResponse.json(trader.status()); }

export async function POST(request: Request) {
  try {
    const provider = new URL(request.url).searchParams.get("provider") ?? process.env.MARKET_DATA_PROVIDER ?? "groww";
    const growwConfigured = Boolean(process.env.GROWW_ACCESS_TOKEN || (process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET));
    if (provider === "groww" && growwConfigured) {
      const result = await new GrowwAdapter(createGrowwTransport()).getQuotes(symbols);
      if (result.ok) return NextResponse.json({ ...(await trader.tick(result.value)), marketData: { source: "Groww real-time market data", delayed: false } });
    }
    const origin = new URL(request.url).origin;
    const response = await fetch(`${origin}/api/market-data?provider=${encodeURIComponent(provider)}&symbols=${symbols.join(",")}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.quotes)) throw new Error("Market data is temporarily unavailable");
    return NextResponse.json({ ...(await trader.tick(data.quotes)), marketData: { source: data.source ?? "Delayed market data", delayed: Boolean(data.delayed) } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Paper market-data tick failed", status: trader.status() }, { status: 503 }); }
}

export async function DELETE() { return NextResponse.json(trader.reset()); }