import { NextResponse } from "next/server";
import { createGrowwTransport } from "../../../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../../../adapters/groww/src/groww-instruments";
import { safeMarketDataError } from "../../../../lib/market-data-errors";

// Intraday premium candles for one option contract (the scalper desk's CALL/PUT charts).
const INTERVALS: Record<string, number> = { "1m": 1, "3m": 3, "5m": 5, "15m": 15 };
const toGrowwDate = (value: Date) => value.toISOString().slice(0, 19).replace("T", " ");

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = (params.get("symbol") ?? "").toUpperCase();
  const timeframe = params.get("timeframe") ?? "1m";
  if (!/^[A-Z0-9-]{6,40}$/.test(symbol) || !INTERVALS[timeframe]) return NextResponse.json({ error: "Unsupported contract or timeframe" }, { status: 400 });
  try {
    const catalog = await loadGrowwInstrumentCatalog();
    const instrument = catalog.getByTradingSymbol("NSE", symbol) ?? catalog.getByTradingSymbol("BSE", symbol);
    const exchange = instrument?.exchange ?? (symbol.startsWith("SENSEX") || symbol.startsWith("BANKEX") ? "BSE" : "NSE");
    // Today's session plus the previous two days, so the first minutes of a session still show context.
    const end = new Date();
    const start = new Date(end.getTime() - (timeframe === "1m" ? 1 : 3) * 86_400_000);
    const response = await createGrowwTransport().request(`/v1/historical/candle/range?exchange=${exchange}&segment=FNO&trading_symbol=${encodeURIComponent(instrument?.tradingSymbol ?? symbol)}&start_time=${encodeURIComponent(toGrowwDate(start))}&end_time=${encodeURIComponent(toGrowwDate(end))}&interval_in_minutes=${INTERVALS[timeframe]}`, { method: "GET" });
    const payload = ((response as { payload?: Record<string, unknown> })?.payload ?? response) as Record<string, unknown>;
    const rows = (payload?.candles ?? []) as unknown[];
    const candles = rows.flatMap((row) => {
      if (!Array.isArray(row) || row.length < 5) return [];
      const [time, open, high, low, close, volume] = row.map(Number);
      return [time, open, high, low, close].every(Number.isFinite) ? [{ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }] : [];
    });
    return NextResponse.json({ symbol, exchange, timeframe, candles, source: "Groww FNO historical candles" });
  } catch (error) {
    return NextResponse.json({ symbol, timeframe, candles: [], error: safeMarketDataError(error, "Option history unavailable") }, { status: 503 });
  }
}
