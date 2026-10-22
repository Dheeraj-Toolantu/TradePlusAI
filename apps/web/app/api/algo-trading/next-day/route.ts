import { NextResponse } from "next/server";
import { istDate } from "../../../../lib/market-intel";
import { getIndexSentiment } from "../../../../lib/index-sentiment";
import { runPythonModule } from "../../../../lib/python";

// Next-day setup per index: the predicted opening (gap up / gap down / flat) from the last
// completed session's opening and closing candles, plus a planned OTM option trade with entry
// trigger, stop, trailing stop and target. After 15:30 IST it describes tomorrow; during the
// session it is the plan that was made after yesterday's close.
const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
type Index = typeof INDICES[number];
type Setup = Record<string, unknown> & { symbol: string; status: string; session_date?: string };

const TTL_MS = 10 * 60_000;
const store = globalThis as typeof globalThis & { __tradepulseNextDay?: Map<Index, { at: number; value: Setup }> };
const cache = (store.__tradepulseNextDay ??= new Map());

async function json(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { ...body, error: body.error ?? `HTTP ${response.status}` };
}

async function build(symbol: Index, origin: string, sentiment: Promise<Record<string, unknown> | null>): Promise<Setup> {
  const date = istDate();
  // 15-minute candles for a month: the opening/closing candles of each session and ~20 sessions
  // of track record. Daily candles give ATR14 and the typical overnight gap.
  const [intraday, daily, chain, reading] = await Promise.all([
    json(`${origin}/api/market-data/history?provider=groww&symbol=${symbol}&timeframe=15m&period=month&date=${date}`),
    json(`${origin}/api/market-data/history?provider=groww&symbol=${symbol}&timeframe=1D&period=month&date=${date}`).catch(() => ({})),
    json(`${origin}/api/option-chain?symbol=${symbol}&full=1`).catch(() => null),
    sentiment,
  ]);
  if (!Array.isArray(intraday.candles) || !intraday.candles.length) return { symbol, status: "NO_DATA", reason: String(intraday.error ?? "15-minute candles are unavailable") };
  const index = (reading?.indices as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === symbol);
  return runPythonModule<Setup>("tradepulse_quant.algo_engine.next_day", {
    symbol,
    candles: intraday.candles,
    daily_candles: Array.isArray(daily?.candles) ? daily.candles : [],
    option_chain: chain && Array.isArray(chain.contracts) ? { spot: chain.spot ?? null, contracts: chain.contracts } : null,
    index_sentiment: index ? { score: index.score, label: index.label } : null,
    delayed: Boolean(intraday.delayed),
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const wanted = (url.searchParams.get("symbol") ?? "ALL").toUpperCase();
  const symbols = wanted === "ALL" ? [...INDICES] : INDICES.filter((item) => item === wanted);
  if (!symbols.length) return NextResponse.json({ error: "Next-day setups cover NIFTY, BANKNIFTY and SENSEX" }, { status: 400 });
  const force = url.searchParams.get("refresh") === "1";
  // Sentiment is context only: use whatever the scanner has, never wait on a cold scan.
  const sentiment = Promise.race([
    getIndexSentiment().then((value) => value as unknown as Record<string, unknown>).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
  ]);
  const setups = await Promise.all(symbols.map(async (symbol) => {
    const hit = cache.get(symbol);
    if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
    try {
      const value = await build(symbol, url.origin, sentiment);
      if (value.status === "READY") cache.set(symbol, { at: Date.now(), value });
      return value;
    } catch (error) {
      return { symbol, status: "ERROR", reason: error instanceof Error ? error.message : "Next-day setup failed" } as Setup;
    }
  }));
  return NextResponse.json({ setups, generated_at: new Date().toISOString() });
}
