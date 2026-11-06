/**
 * Option-writer OI for the sentiment history: total call OI (call writers' open shorts) and put
 * OI (put writers') on the nearest expiry, within ±6% of spot, as the market-intel engine reads it.
 *
 * The server samples it every 3 minutes; each 5-minute snapshot stores the average of the samples
 * taken since the previous one. % changes are worked out on those averages against the previous
 * snapshot and the day's first, from the totals kept in the history state.
 */
/** One strike's open interest (and last price) on the nearest expiry. */
export type StrikeOi = { strike: number; ce_oi: number; pe_oi: number; ce_ltp: number | null; pe_ltp: number | null };
export type OiTotals = { expiry: string; call_oi: number; put_oi: number; pcr: number | null; spot: number | null; at: string; strikes?: StrikeOi[] };
export type OiBaseline = { date: string; call_oi: number; put_oi: number; open_call_oi: number; open_put_oi: number; at: string };
export type OiReading = OiTotals & {
  /** How many 3-minute samples the snapshot's average is made of. */
  samples: number;
  call_change_pct: number | null; put_change_pct: number | null; call_change_day_pct: number | null; put_change_day_pct: number | null;
  call_writers: WriterAction; put_writers: WriterAction; signal: string;
};
export type WriterAction = "ADDING" | "COVERING" | "FLAT" | "UNKNOWN";

const OI_INDICES = ["NIFTY", "BANKNIFTY", "SENSEX"] as const;
/** OI moving less than this (%) between snapshots counts as flat. */
export const OI_FLAT_PCT = 0.5;

const round = (value: number | null, digits = 2) => (value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const change = (now: number, before: number | undefined) => (before && before > 0 ? round(((now - before) / before) * 100) : null);
const action = (pct: number | null): WriterAction => (pct === null ? "UNKNOWN" : pct >= OI_FLAT_PCT ? "ADDING" : pct <= -OI_FLAT_PCT ? "COVERING" : "FLAT");

/**
 * What the writers' moves mean: put writers adding (support under the market) or call writers
 * covering is bullish; call writers adding (a ceiling) or put writers covering is bearish.
 */
export function writerSignal(call: WriterAction, put: WriterAction): string {
  const bull = (put === "ADDING" ? 1 : 0) + (call === "COVERING" ? 1 : 0);
  const bear = (call === "ADDING" ? 1 : 0) + (put === "COVERING" ? 1 : 0);
  if (call === "UNKNOWN" && put === "UNKNOWN") return "First reading: change shows from the next snapshot";
  if (bull > bear) return bull === 2 ? "Bullish: put writers adding, call writers covering" : put === "ADDING" ? "Bullish lean: put writers adding" : "Bullish lean: call writers covering";
  if (bear > bull) return bear === 2 ? "Bearish: call writers adding, put writers covering" : call === "ADDING" ? "Bearish lean: call writers adding" : "Bearish lean: put writers covering";
  if (call === "ADDING" && put === "ADDING") return "Range: writers adding on both sides";
  if (call === "COVERING" && put === "COVERING") return "Breakout risk: writers covering on both sides";
  return "Neutral: writer OI little changed";
}

/** Combine this reading with the stored baseline: % changes, writer actions, and the next baseline. */
export function oiReading(totals: OiTotals & { samples?: number }, baseline: OiBaseline | undefined, date: string): { reading: OiReading; next: OiBaseline } {
  const sameDay = baseline?.date === date;
  const callPct = sameDay ? change(totals.call_oi, baseline?.call_oi) : null;
  const putPct = sameDay ? change(totals.put_oi, baseline?.put_oi) : null;
  const openCall = sameDay ? baseline!.open_call_oi : totals.call_oi;
  const openPut = sameDay ? baseline!.open_put_oi : totals.put_oi;
  const callWriters = action(callPct); const putWriters = action(putPct);
  return {
    reading: {
      ...totals, samples: totals.samples ?? 1, call_change_pct: callPct, put_change_pct: putPct,
      call_change_day_pct: sameDay ? change(totals.call_oi, openCall) : null, put_change_day_pct: sameDay ? change(totals.put_oi, openPut) : null,
      call_writers: callWriters, put_writers: putWriters, signal: writerSignal(callWriters, putWriters),
    },
    next: { date, call_oi: totals.call_oi, put_oi: totals.put_oi, open_call_oi: openCall, open_put_oi: openPut, at: totals.at },
  };
}

/** Total call and put OI for one index (nearest expiry, ±6% of spot). */
export async function readOiTotals(symbol: string): Promise<OiTotals> {
  const { contractMeta, fetchChain, isIntelSymbol } = await import("./market-intel");
  if (!isIntelSymbol(symbol)) throw new Error(`No option chain for ${symbol}`);
  const { expiry } = await contractMeta(symbol);
  const { spot, rows } = await fetchChain(symbol, expiry);
  const call = rows.reduce((sum, row) => sum + (row.ce?.oi ?? 0), 0);
  const put = rows.reduce((sum, row) => sum + (row.pe?.oi ?? 0), 0);
  if (!(call > 0) && !(put > 0)) throw new Error(`The ${symbol} option chain returned no open interest`);
  const strikes = rows.map((row) => ({ strike: row.strike, ce_oi: row.ce?.oi ?? 0, pe_oi: row.pe?.oi ?? 0, ce_ltp: row.ce?.ltp ?? null, pe_ltp: row.pe?.ltp ?? null }));
  return { expiry, call_oi: call, put_oi: put, pcr: call > 0 ? round(put / call, 3) : null, spot: spot > 0 ? spot : null, at: new Date().toISOString(), strikes };
}

/** Totals without the strike rows (what the sentiment snapshots store). */
export const withoutStrikes = (value: OiTotals): OiTotals => { const { strikes: _strikes, ...rest } = value; void _strikes; return rest; };

/** Every index's OI; an index that fails is left out (the snapshot is still saved). */
export async function readAllOi(read: (symbol: string) => Promise<OiTotals> = readOiTotals, ids: readonly string[] = OI_INDICES): Promise<Record<string, OiTotals>> {
  const results = await Promise.allSettled(ids.map(async (id) => [id, await read(id)] as const));
  return Object.fromEntries(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
}
