// Open-interest analysis for NIFTY / BANK NIFTY / SENSEX from the stored 3-minute strike samples.
//
// Every sample is the nearest-expiry chain within ±6% of spot: each strike's call and put OI. The
// day's first sample is the base (normally 09:15). For any later sample (the latest, or one picked
// on the replay slider) this works out, per strike and in total, OI at the base, OI now and the
// change, and reads it against the index price:
//
//   price up   + put OI up / call OI down   → bullish (put writers support it, call writers cover)
//   price down + call OI up / put OI down   → bearish (call writers cap it, put writers run)
//   price up   + call OI up faster          → rally into call writing (capped)
//   price down + put OI up faster           → dip into put writing (supported)
//
// Support / resistance are the strikes with the most put OI at or below spot and the most call OI at
// or above it; their shift since the base shows writers rolling up or down. Analysis only.

import type { StrikeOi } from "./oi-history";

export type StrikeSample = { at: string; time: string; spot: number | null; call_oi: number; put_oi: number; pcr: number | null; expiry: string; strikes: StrikeOi[]; live?: boolean };
export type StrikeRow = { strike: number; ce_base: number; ce_now: number; ce_chg: number; pe_base: number; pe_now: number; pe_chg: number };
export type Wall = { strike: number; oi: number } | null;
export type SeriesPoint = { at: string; time: string; spot: number | null; call_oi: number; put_oi: number; pcr: number | null; ce_chg: number; pe_chg: number };
export type OiAnalysis = {
  base: { at: string; time: string; spot: number | null }; current: { at: string; time: string; spot: number | null; live: boolean };
  step: number; atm: number | null; expiry: string;
  rows: StrikeRow[];
  totals: { ce_base: number; ce_now: number; ce_chg: number; ce_chg_pct: number | null; pe_base: number; pe_now: number; pe_chg: number; pe_chg_pct: number | null; pcr_base: number | null; pcr_now: number | null; pcr_atm: number | null };
  spot_chg: number | null; spot_chg_pct: number | null;
  support: Wall; resistance: Wall; support_base: Wall; resistance_base: Wall;
  put_buildup: StrikeRow[]; call_buildup: StrikeRow[]; put_unwinding: StrikeRow[]; call_unwinding: StrikeRow[];
  max_pain: number | null;
  recent: { minutes: number; spot_chg: number | null; ce_chg: number; pe_chg: number; label: string } | null;
  bias: { score: number; label: string; lines: string[] };
  series: SeriesPoint[];
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const pctOf = (change: number, base: number) => (base > 0 ? round((change / base) * 100) : null);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const units = (value: number) => { const abs = Math.abs(value); const sign = value < 0 ? "−" : value > 0 ? "+" : ""; return abs >= 1e7 ? `${sign}${(abs / 1e7).toFixed(2)} Cr` : `${sign}${(abs / 1e5).toFixed(2)} L`; };

function stepOf(strikes: number[]) {
  let step = Infinity;
  for (let i = 1; i < strikes.length; i += 1) step = Math.min(step, strikes[i] - strikes[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : 50;
}

/** Change in total call / put OI between two samples, on the strikes both have. */
export function changeOn(from: StrikeSample, to: StrikeSample) {
  const before = new Map(from.strikes.map((row) => [row.strike, row]));
  let ce = 0; let pe = 0;
  for (const row of to.strikes) { const old = before.get(row.strike); if (old) { ce += row.ce_oi - old.ce_oi; pe += row.pe_oi - old.pe_oi; } }
  return { ce, pe };
}

export function maxPain(strikes: StrikeOi[]): number | null {
  let best: number | null = null; let pain = Infinity;
  for (const settle of strikes) {
    let total = 0;
    for (const row of strikes) total += Math.max(0, settle.strike - row.strike) * row.ce_oi + Math.max(0, row.strike - settle.strike) * row.pe_oi;
    if (total < pain) { pain = total; best = settle.strike; }
  }
  return strikes.some((row) => row.ce_oi > 0 || row.pe_oi > 0) ? best : null;
}

function walls(strikes: StrikeOi[], spot: number | null): { support: Wall; resistance: Wall } {
  let support: Wall = null; let resistance: Wall = null;
  for (const row of strikes) {
    if ((spot === null || row.strike <= spot) && (!support || row.pe_oi > support.oi)) support = { strike: row.strike, oi: row.pe_oi };
    if ((spot === null || row.strike >= spot) && (!resistance || row.ce_oi > resistance.oi)) resistance = { strike: row.strike, oi: row.ce_oi };
  }
  return { support, resistance };
}

/** Price vs writer OI over a stretch: what the combination means. */
export function buildupLabel(spotChange: number | null, ceChange: number, peChange: number): string {
  const up = (spotChange ?? 0) > 0; const down = (spotChange ?? 0) < 0;
  if (up && peChange > 0 && ceChange <= 0) return "Bullish: put writers adding under a rising market, call writers covering";
  if (down && ceChange > 0 && peChange <= 0) return "Bearish: call writers adding over a falling market, put writers covering";
  if (up && ceChange > peChange && ceChange > 0) return "Rally into call writing: upside capped unless calls cover";
  if (down && peChange > ceChange && peChange > 0) return "Dip into put writing: downside supported unless puts unwind";
  if (up && ceChange < 0 && peChange < 0) return "Short covering on both sides: a fast, fragile move up";
  if (down && ceChange < 0 && peChange < 0) return "Unwinding on both sides: writers stepping back as it falls";
  if (peChange > 0 && ceChange > 0) return "Range: writers adding on both sides";
  return "Quiet: little change in writer OI";
}

/**
 * Analyse the day's samples against the first one. `at` picks the sample to compare (replay);
 * `range` keeps that many strikes either side of the at-the-money strike in `rows`.
 */
export function analyzeOi(input: StrikeSample[], options: { at?: number; range?: number } = {}): OiAnalysis | null {
  const samples = input.filter((sample) => sample.strikes?.length).sort((a, b) => a.at.localeCompare(b.at));
  if (!samples.length) return null;
  const base = samples[0];
  const index = options.at === undefined ? samples.length - 1 : clamp(Math.round(options.at), 0, samples.length - 1);
  const current = samples[index];
  const range = options.range ?? 10;
  const baseBy = new Map(base.strikes.map((row) => [row.strike, row]));
  // Only strikes present now; a strike missing from the base (the ±6% window moved with spot) counts
  // as unchanged, so a shifting window never shows up as fresh OI.
  const allStrikes = [...new Set(current.strikes.map((row) => row.strike))].sort((a, b) => a - b);
  const step = stepOf(allStrikes);
  const spot = current.spot ?? base.spot;
  const atm = spot === null ? null : allStrikes.reduce((best, strike) => (Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best), allStrikes[0]);
  const nowBy = new Map(current.strikes.map((row) => [row.strike, row]));
  const every: StrikeRow[] = allStrikes.map((strike) => {
    const before = baseBy.get(strike); const now = nowBy.get(strike);
    const ceNow = now?.ce_oi ?? 0; const peNow = now?.pe_oi ?? 0; const ceBase = before ? before.ce_oi : ceNow; const peBase = before ? before.pe_oi : peNow;
    return { strike, ce_base: ceBase, ce_now: ceNow, ce_chg: ceNow - ceBase, pe_base: peBase, pe_now: peNow, pe_chg: peNow - peBase };
  });
  const rows = atm === null ? every : every.filter((row) => Math.abs(row.strike - atm) <= range * step + 1e-6);
  const sum = (pick: (row: StrikeRow) => number) => every.reduce((total, row) => total + pick(row), 0);
  const ceBase = sum((row) => row.ce_base); const ceNow = sum((row) => row.ce_now); const peBase = sum((row) => row.pe_base); const peNow = sum((row) => row.pe_now);
  const near = atm === null ? every : every.filter((row) => Math.abs(row.strike - atm) <= 3 * step + 1e-6);
  const nearCe = near.reduce((total, row) => total + row.ce_now, 0); const nearPe = near.reduce((total, row) => total + row.pe_now, 0);
  const nowWalls = walls(current.strikes, current.spot); const baseWalls = walls(base.strikes, base.spot);
  const spotChange = current.spot !== null && base.spot !== null ? round(current.spot - base.spot) : null;
  const top = (pick: (row: StrikeRow) => number, sign: 1 | -1) => [...every].filter((row) => pick(row) * sign > 0).sort((a, b) => (pick(b) - pick(a)) * sign).slice(0, 3);

  // The last ~15 minutes (5 samples back), to say what is happening now.
  const back = samples[Math.max(0, index - 5)];
  const recent = back === current ? null : (() => {
    const { ce, pe } = changeOn(back, current);
    const move = current.spot !== null && back.spot !== null ? round(current.spot - back.spot) : null;
    return { minutes: Math.round((Date.parse(current.at) - Date.parse(back.at)) / 60_000), spot_chg: move, ce_chg: ce, pe_chg: pe, label: buildupLabel(move, ce, pe) };
  })();

  const cePct = pctOf(ceNow - ceBase, ceBase); const pePct = pctOf(peNow - peBase, peBase);
  const pcrNow = ceNow > 0 ? round(peNow / ceNow, 3) : null; const pcrBase = ceBase > 0 ? round(peBase / ceBase, 3) : null;
  const spotPct = spotChange !== null && base.spot ? round((spotChange / base.spot) * 100) : null;
  // Bias: writers (put OI growth vs call OI growth) weigh most, then price, then the PCR level.
  const writer = clamp(((pePct ?? 0) - (cePct ?? 0)) * 6, -55, 55);
  const price = clamp((spotPct ?? 0) * 40, -25, 25);
  const level = pcrNow === null ? 0 : clamp((pcrNow - 1) * 30, -20, 20);
  const score = Math.round(clamp(writer + price + level, -100, 100));
  const label = score >= 40 ? "Strongly bullish" : score >= 15 ? "Bullish" : score <= -40 ? "Strongly bearish" : score <= -15 ? "Bearish" : "Neutral";
  const lines = [
    `Since ${base.time}: call OI ${units(ceNow - ceBase)} (${cePct === null ? "--" : `${cePct > 0 ? "+" : ""}${cePct}%`}), put OI ${units(peNow - peBase)} (${pePct === null ? "--" : `${pePct > 0 ? "+" : ""}${pePct}%`}), index ${spotChange === null ? "--" : `${spotChange > 0 ? "+" : ""}${spotChange} pts`}.`,
    buildupLabel(spotChange, ceNow - ceBase, peNow - peBase) + ".",
  ];
  if (nowWalls.support && baseWalls.support && nowWalls.support.strike !== baseWalls.support.strike) lines.push(`Put support moved ${nowWalls.support.strike > baseWalls.support.strike ? "up" : "down"} from ${baseWalls.support.strike} to ${nowWalls.support.strike}.`);
  if (nowWalls.resistance && baseWalls.resistance && nowWalls.resistance.strike !== baseWalls.resistance.strike) lines.push(`Call resistance moved ${nowWalls.resistance.strike > baseWalls.resistance.strike ? "up" : "down"} from ${baseWalls.resistance.strike} to ${nowWalls.resistance.strike}.`);
  if (pcrNow !== null) lines.push(`PCR ${pcrNow.toFixed(2)}${pcrBase !== null ? ` (from ${pcrBase.toFixed(2)})` : ""}${pcrNow > 1.6 ? ": heavy put writing, crowded; watch for unwinding" : pcrNow < 0.6 ? ": heavy call writing, crowded; watch for short covering" : ""}.`);
  if (recent) lines.push(`Last ${recent.minutes} min: ${recent.label.toLowerCase()}.`);

  return {
    base: { at: base.at, time: base.time, spot: base.spot }, current: { at: current.at, time: current.time, spot: current.spot, live: Boolean(current.live) },
    step, atm, expiry: current.expiry, rows,
    totals: { ce_base: ceBase, ce_now: ceNow, ce_chg: ceNow - ceBase, ce_chg_pct: cePct, pe_base: peBase, pe_now: peNow, pe_chg: peNow - peBase, pe_chg_pct: pePct, pcr_base: pcrBase, pcr_now: pcrNow, pcr_atm: nearCe > 0 ? round(nearPe / nearCe, 3) : null },
    spot_chg: spotChange, spot_chg_pct: spotPct,
    support: nowWalls.support, resistance: nowWalls.resistance, support_base: baseWalls.support, resistance_base: baseWalls.resistance,
    put_buildup: top((row) => row.pe_chg, 1), call_buildup: top((row) => row.ce_chg, 1), put_unwinding: top((row) => row.pe_chg, -1), call_unwinding: top((row) => row.ce_chg, -1),
    max_pain: maxPain(current.strikes), recent, bias: { score, label, lines },
    series: samples.slice(0, index + 1).map((sample) => {
      const ce = sample.strikes.reduce((acc, row) => acc + row.ce_oi, 0); const pe = sample.strikes.reduce((acc, row) => acc + row.pe_oi, 0);
      const change = changeOn(base, sample);
      return { at: sample.at, time: sample.time, spot: sample.spot, call_oi: ce, put_oi: pe, pcr: ce > 0 ? round(pe / ce, 3) : null, ce_chg: change.ce, pe_chg: change.pe };
    }),
  };
}
