import { NextResponse } from "next/server";
import { createGrowwTransport } from "../../../../../adapters/groww/src/groww-adapter";
import { loadGrowwInstrumentCatalog } from "../../../../../adapters/groww/src/groww-instruments";
import { safeMarketDataError } from "../../../lib/market-data-errors";

function payloadOf(value: unknown) { return ((value as { payload?: Record<string, unknown> })?.payload ?? {}) as Record<string, unknown>; }
function num(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }

type ChainSide = { greeks?: Record<string, unknown>; ltp?: unknown; open_interest?: unknown; volume?: unknown; trading_symbol?: unknown };

function scoreContract(args: { strike: number; spot: number; bid: number; ask: number; premium: number; openInterest: number; volume: number; iv: number; delta: number }) {
  const { strike, spot, bid, ask, premium, openInterest, volume, iv, delta } = args;
  // Distance from ATM: linear ramp, 0 at ~2.5% out.
  const distPct = Math.abs(strike - spot) / Math.max(spot, 1);
  const moneynessScore = Math.max(0, 1 - distPct / 0.025) * 30;
  const spreadPct = premium > 0 ? (ask - bid) / premium : 1;
  const spreadScore = Math.max(0, 1 - spreadPct / 0.20) * 20;
  // Liquidity: blend volume/OI turnover with absolute OI depth.
  const turnover = volume / Math.max(openInterest, 1);
  const liquidityScore = (Math.min(turnover / 5, 1) * 12) + (Math.min(openInterest / 500000, 1) * 8);
  const ivScore = iv > 0 ? (iv < 20 ? 12 : iv < 35 ? 15 : iv <= 55 ? 9 : 5) : 6;
  const deltaScore = Math.abs(delta) >= 0.4 ? 15 : Math.abs(delta) >= 0.3 ? 12 : Math.abs(delta) >= 0.2 ? 8 : 5;
  return Math.round(Math.max(0, Math.min(100, moneynessScore + spreadScore + liquidityScore + ivScore + deltaScore)));
}

function buildRow(symbol: string, optionType: "CE" | "PE", side: ChainSide | undefined, strike: number, spot: number, lotSize: number, tickSize: number, freezeQuantity: number) {
  const greeks = (side?.greeks ?? {}) as Record<string, unknown>;
  const premium = num(side?.ltp);
  if (premium <= 0) return null;
  const iv = num(greeks.iv);
  const delta = num(greeks.delta);
  const theta = num(greeks.theta);
  const openInterest = num(side?.open_interest);
  const volume = num(side?.volume);
  // Groww chain rows carry LTP but not live bid/ask; approximate the spread from IV.
  const halfSpread = Math.max(premium * (iv > 0 ? Math.min(iv, 60) / 100 * 0.06 : 0.02), tickSize || 0.05);
  const bid = Math.max(premium - halfSpread, tickSize || 0.05);
  const ask = premium + halfSpread;
  const risk = Math.max(premium * 0.08, Math.abs(theta) * 2, 0.05);
  const target = premium + risk * 2;
  const score = scoreContract({ strike, spot, bid, ask, premium, openInterest, volume, iv, delta });
  return {
    symbol,
    contract: optionType === "CE" ? "CALL" : "PUT",
    expiry: "",
    strike,
    premium,
    bid: Math.round(bid * 100) / 100,
    ask: Math.round(ask * 100) / 100,
    openInterest,
    oiChange: 0,
    volume,
    iv: Math.round(iv * 100) / 100,
    delta: Math.round(delta * 1000) / 1000,
    theta: Math.round(theta * 100) / 100,
    lotSize,
    tickSize,
    freezeQuantity,
    score,
    riskReward: Math.round((target - premium) / risk * 100) / 100,
    reason: "Real-time chain Greeks, OI and volume",
  };
}

export async function GET(request: Request) {
  const symbol = (new URL(request.url).searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  try {
    const catalog = await loadGrowwInstrumentCatalog();
    const instruments = catalog.getAll().filter((instrument) => instrument.segment === "FNO" && instrument.underlyingSymbol === symbol && (instrument.instrumentType === "CE" || instrument.instrumentType === "PE") && Boolean(instrument.expiryDate));
    const expiry = instruments.map((instrument) => instrument.expiryDate as string).filter((value) => value >= new Date().toISOString().slice(0, 10)).sort()[0];
    if (!expiry) throw new Error(`No future option expiry available for ${symbol}.`);
    const meta = new Map<string, { lotSize: number; tickSize: number; freezeQuantity: number }>();
    for (const instrument of instruments) if (instrument.expiryDate === expiry) meta.set(instrument.tradingSymbol, { lotSize: Number(instrument.lotSize ?? 0), tickSize: Number(instrument.tickSize ?? 0), freezeQuantity: Number(instrument.freezeQuantity ?? 0) });

    const transport = createGrowwTransport();
    const exchange = symbol === "SENSEX" ? "BSE" : "NSE";
    const chainBody = await transport.request(`/v1/option-chain/exchange/${exchange}/underlying/${encodeURIComponent(symbol)}?expiry_date=${encodeURIComponent(expiry)}`, { method: "GET" });
    const chainPayload = payloadOf(chainBody);
    const spot = num(chainPayload.underlying_ltp ?? chainPayload.underlyingLtp);
    const strikes = (chainPayload.strikes ?? {}) as Record<string, { CE?: ChainSide; PE?: ChainSide }>;

    const rows: Array<Record<string, unknown>> = [];
    for (const [strikeKey, sides] of Object.entries(strikes)) {
      const strike = num(strikeKey);
      if (spot > 0 && Math.abs(strike - spot) / spot > 0.03) continue;
      for (const optionType of ["CE", "PE"] as const) {
        const side = sides[optionType];
        const tradingSymbol = String(side?.trading_symbol ?? "");
        const instrumentMeta = meta.get(tradingSymbol) ?? { lotSize: 0, tickSize: 0, freezeQuantity: 0 };
        const row = buildRow(tradingSymbol || `${symbol}${strike}${optionType}`, optionType, side, strike, spot, instrumentMeta.lotSize, instrumentMeta.tickSize, instrumentMeta.freezeQuantity);
        if (row) rows.push({ ...row, expiry });
      }
    }
    rows.sort((left, right) => Number(right.score) - Number(left.score));
    return NextResponse.json({ symbol, expiry, spot, contracts: rows.slice(0, 16), source: "Groww option chain (Greeks, OI, volume)", updatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ contracts: [], error: safeMarketDataError(error, "Option chain unavailable") }, { status: 503 });
  }
}
