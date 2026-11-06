import { NextResponse } from "next/server";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../../lib/firebase";
import { OI_STRIKES, istDate, istTime, strikeCache, strikeKey } from "../../../lib/sentiment-history";
import { analyzeOi, type StrikeSample } from "../../../lib/oi-analysis";
import { readOiTotals } from "../../../lib/oi-history";
import { GrowwAdapter, createGrowwTransport } from "../../../../../adapters/groww/src/groww-adapter";

const INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
const STALE_MS = 4 * 60_000;
const READ_TIMEOUT_MS = 20_000;

const withTimeout = <T,>(work: Promise<T>, ms = READ_TIMEOUT_MS) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms))]);

/** The day's stored 3-minute strike samples, plus a live chain reading when today's are stale or missing. */
async function samplesFor(symbol: string, date: string, notes: string[]): Promise<StrikeSample[]> {
  const key = strikeKey(symbol, date);
  const cache = strikeCache();
  let cached = cache.get(key) as StrikeSample[] | undefined;
  if (!cached) {
    // Read the day from Firestore once per process; the sampler appends to it from then on.
    const read = await withTimeout(getDocs(query(collection(db, OI_STRIKES), where("key", "==", key))))
      .then((result) => result.docs.map((item) => item.data() as StrikeSample & { recordedAt?: string }).map((row) => ({ ...row, at: row.at ?? row.recordedAt ?? "" })))
      .catch((error: unknown) => { notes.push(`Stored OI unavailable for ${symbol}: ${error instanceof Error ? error.message : "read failed"}`); return null; });
    if (read) { read.sort((a, b) => a.at.localeCompare(b.at)); cache.set(key, read as never); cached = read; }
  }
  const stored: StrikeSample[] = [...(cached ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const today = istDate(new Date());
  const newest = stored.at(-1);
  if (date === today && (!newest || Date.now() - Date.parse(newest.at) > STALE_MS)) {
    try {
      const live = await withTimeout(readOiTotals(symbol));
      const now = new Date();
      stored.push({ at: now.toISOString(), time: istTime(now), spot: live.spot, call_oi: live.call_oi, put_oi: live.put_oi, pcr: live.pcr, expiry: live.expiry, strikes: live.strikes ?? [], live: true });
      if (stored.length === 1) notes.push(`${symbol}: no OI stored yet today, so the change is measured from now. The server stores the chain every 3 minutes in market hours.`);
    } catch (error) {
      if (!stored.length) notes.push(`${symbol}: live option chain unavailable (${error instanceof Error ? error.message : "failed"})`);
    }
  }
  return stored;
}

async function vix() {
  try {
    const result = await new GrowwAdapter(createGrowwTransport()).getQuotes(["INDIA VIX"]);
    if ("error" in result) return null;
    const quote = result.value[0];
    return quote && quote.price > 0 ? { value: quote.price, change: quote.change ?? null, percent: quote.percent ?? null } : null;
  } catch { return null; }
}

// GET ?symbol=NIFTY&date=2026-11-06[&since=ISO]: the day's 3-minute strike samples for one index (only
// those after `since` when given; the page keeps the rest), for the strike chart and its replay.
// GET ?summary=1[&date=]: the analysis (no strike rows) for NIFTY, BANK NIFTY and SENSEX.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const date = params.get("date") || istDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  const notes: string[] = [];
  const headers = { "cache-control": "no-store" };
  if (params.get("summary") === "1") {
    const [indices, volatility] = await Promise.all([
      Promise.all(INDICES.map(async (symbol) => { const analysis = analyzeOi(await samplesFor(symbol, date, notes)); return { symbol, analysis: analysis ? { ...analysis, rows: [] } : null }; })),
      vix(),
    ]);
    return NextResponse.json({ date, vix: volatility, indices, notes }, { headers });
  }
  const symbol = String(params.get("symbol") ?? "NIFTY").toUpperCase();
  if (!(INDICES as readonly string[]).includes(symbol)) return NextResponse.json({ error: "symbol must be NIFTY, BANKNIFTY or SENSEX" }, { status: 400 });
  const since = params.get("since");
  const [samples, volatility] = await Promise.all([samplesFor(symbol, date, notes), vix()]);
  const rows = since ? samples.filter((sample) => sample.at > since || sample.live) : samples;
  return NextResponse.json({ symbol, date, vix: volatility, samples: rows.map(({ at: when, time, spot, call_oi, put_oi, pcr, expiry, strikes, live }) => ({ at: when, time, spot, call_oi, put_oi, pcr, expiry, strikes, live: Boolean(live) })), notes }, { headers });
}
