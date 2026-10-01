import { NextResponse } from "next/server";
import { getMarketIntel, isIntelSymbol } from "../../../lib/market-intel";
import { safeMarketDataError } from "../../../lib/market-data-errors";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  if (!isIntelSymbol(symbol)) return NextResponse.json({ available: false, error: "Market intelligence supports NIFTY, BANKNIFTY and SENSEX." }, { status: 400 });
  const capital = Number(url.searchParams.get("capital"));
  const riskPct = Number(url.searchParams.get("riskPct"));
  try {
    const intel = await getMarketIntel(symbol, {
      origin: url.origin,
      capital: Number.isFinite(capital) && capital >= 10_000 ? Math.min(capital, 100_000_000) : undefined,
      riskPct: Number.isFinite(riskPct) && riskPct > 0 ? Math.min(riskPct, 2) : undefined,
    });
    return NextResponse.json(intel);
  } catch (error) {
    return NextResponse.json({ symbol, available: false, error: safeMarketDataError(error, "Market intelligence unavailable") }, { status: 503 });
  }
}
