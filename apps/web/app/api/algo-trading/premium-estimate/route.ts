import { NextResponse } from "next/server";
import { runPythonModule } from "../../../../lib/python";

// Premium at the next session's open if the index is at a chosen key level. The option chain
// fills the contract's premium, bid/ask, IV, expiry and the index price; any of them can be
// overridden in the body (a custom premium, for instance).
const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"];
const FIELDS = ["premium", "spot", "expiry", "iv_change", "bid", "ask", "now"] as const;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const symbol = String(body.symbol ?? "NIFTY").toUpperCase();
  if (!INDICES.includes(symbol)) return NextResponse.json({ status: "ERROR", reason: "Premium estimates cover NIFTY, BANKNIFTY and SENSEX" }, { status: 400 });
  const optionType = String(body.option_type ?? "").toUpperCase();
  const strike = Number(body.strike);
  const keyLevel = Number(body.key_level);
  if (!["CE", "PE"].includes(optionType) || !(strike > 0) || !(keyLevel > 0)) {
    return NextResponse.json({ status: "ERROR", reason: "Choose CE or PE, a strike and a key level" }, { status: 400 });
  }
  const origin = new URL(request.url).origin;
  const chain = await fetch(`${origin}/api/option-chain?symbol=${symbol}&full=1`, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const payload: Record<string, unknown> = {
    symbol, option_type: optionType, strike, key_level: keyLevel,
    option_chain: chain && Array.isArray(chain.contracts) ? { spot: chain.spot ?? null, contracts: chain.contracts } : null,
  };
  for (const field of FIELDS) if (body[field] !== undefined && body[field] !== null && body[field] !== "") payload[field] = body[field];
  try {
    const result = await runPythonModule<Record<string, unknown>>("tradepulse_quant.algo_engine.open_premium", payload, 20_000);
    return NextResponse.json(result, { status: result.status === "READY" ? 200 : 422 });
  } catch (error) {
    return NextResponse.json({ status: "ERROR", reason: error instanceof Error ? error.message : "Premium estimate failed" }, { status: 500 });
  }
}
