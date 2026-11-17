/**
 * The underlyings the algo page and the Smart Scalper trade, and their sessions (browser-safe: no
 * broker or Firestore code). Contract details (exchange segment, trading symbols, expiries, lot and
 * tick sizes) are never written here: they come from Groww's instrument catalog at runtime
 * (lib/underlying-catalog.ts).
 *
 * Index options (NSE / BSE) read the index's cash quote as spot. MCX commodity options are options
 * on futures, so a commodity's "spot" and its 1m / 5m tape are the nearest unexpired future.
 *
 * Session minutes are IST. The commodity window is a conservative assumption (MCX's normal session
 * is 09:00 to 23:30 IST, and later on some days): entries stop at 22:45 and engine positions are
 * squared off at 23:00, before the exchange closes. Change them here if your broker differs.
 */

export type UnderlyingKind = "INDEX" | "COMMODITY";
export type Session = { open: number; entryStart: number; entryEnd: number; squareOff: number };
export type UnderlyingDef = { id: string; name: string; kind: UnderlyingKind; exchange: "NSE" | "BSE" | "MCX"; session: Session };

const INDEX_SESSION: Session = { open: 9 * 60 + 15, entryStart: 9 * 60 + 15, entryEnd: 15 * 60 + 15, squareOff: 15 * 60 + 15 };
const MCX_SESSION: Session = { open: 9 * 60, entryStart: 9 * 60 + 20, entryEnd: 22 * 60 + 45, squareOff: 23 * 60 };

export const UNDERLYINGS: Record<string, UnderlyingDef> = {
  NIFTY: { id: "NIFTY", name: "NIFTY", kind: "INDEX", exchange: "NSE", session: INDEX_SESSION },
  BANKNIFTY: { id: "BANKNIFTY", name: "BANK NIFTY", kind: "INDEX", exchange: "NSE", session: INDEX_SESSION },
  SENSEX: { id: "SENSEX", name: "SENSEX", kind: "INDEX", exchange: "BSE", session: INDEX_SESSION },
  CRUDEOIL: { id: "CRUDEOIL", name: "CRUDE OIL", kind: "COMMODITY", exchange: "MCX", session: MCX_SESSION },
  GOLD: { id: "GOLD", name: "GOLD", kind: "COMMODITY", exchange: "MCX", session: MCX_SESSION },
};

/** What the algo page and the Scalper offer, in display order. */
export const ALGO_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "GOLD"] as const;
export type AlgoUnderlying = (typeof ALGO_UNDERLYINGS)[number];

export const isAlgoUnderlying = (value: string): value is AlgoUnderlying => (ALGO_UNDERLYINGS as readonly string[]).includes(value);
export const isCommodity = (value: string) => UNDERLYINGS[value]?.kind === "COMMODITY";
export const underlyingName = (value: string) => UNDERLYINGS[value]?.name ?? value;
export const sessionFor = (value: string): Session => UNDERLYINGS[value]?.session ?? INDEX_SESSION;
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const entryWindowLabel = (value: string) => { const s = sessionFor(value); return `${hhmm(s.entryStart)}-${hhmm(s.entryEnd)} IST`; };
export const squareOffLabel = (value: string) => hhmm(sessionFor(value).squareOff);

/** IST weekday (0 = Sunday) and minutes since midnight. */
export function istClock(ms: number) {
  const d = new Date(ms + 330 * 60_000);
  return { weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
/** Weekday and inside the underlying's entry window. Exchange holidays are not modelled here. */
export function entryOpen(underlying: string, ms: number) {
  const { weekday, minutes } = istClock(ms);
  const s = sessionFor(underlying);
  return weekday !== 0 && weekday !== 6 && minutes >= s.entryStart && minutes < s.entryEnd;
}
