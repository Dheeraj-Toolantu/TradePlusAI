import { NextResponse } from "next/server";
import { loadGrowwInstrumentCatalog } from "../../../../../adapters/groww/src/groww-instruments";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim().toUpperCase() ?? "";
  const type = params.get("type")?.trim().toUpperCase();
  const expiry = params.get("expiry")?.trim();
  if (query.length < 2) return NextResponse.json({ instruments: [] });
  try {
    const catalog = await loadGrowwInstrumentCatalog();
    const matches = catalog.getAll().filter((instrument) => instrument.segment === "FNO" && (instrument.instrumentType === "CE" || instrument.instrumentType === "PE") && (!type || instrument.instrumentType === type) && (!expiry || instrument.expiryDate === expiry) && [instrument.tradingSymbol, instrument.growwSymbol, instrument.underlyingSymbol].some((value) => value?.toUpperCase().includes(query))).sort((left, right) => Number(right.underlyingSymbol?.toUpperCase() === query) - Number(left.underlyingSymbol?.toUpperCase() === query) || String(left.expiryDate).localeCompare(String(right.expiryDate)) || Number(left.strikePrice ?? 0) - Number(right.strikePrice ?? 0));
    const instruments = matches.slice(0, 40).map((instrument) => ({ symbol: instrument.tradingSymbol, growwSymbol: instrument.growwSymbol, underlying: instrument.underlyingSymbol, type: instrument.instrumentType, expiry: instrument.expiryDate, strike: instrument.strikePrice, lotSize: instrument.lotSize, tickSize: instrument.tickSize, freezeQuantity: instrument.freezeQuantity, active: instrument.isReserved !== true && instrument.buyAllowed !== false, exchange: instrument.exchange }));
    return NextResponse.json({ instruments, source: "Groww instrument catalog" });
  } catch (error) { return NextResponse.json({ instruments: [], error: error instanceof Error ? error.message : "Groww instruments unavailable" }, { status: 503 }); }
}
