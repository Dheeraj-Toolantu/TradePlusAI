// In-process ring buffer of option-chain snapshots used to measure 5-minute OI change.
// Groww's chain payload carries current OI only, so "change in OI over 5 minutes" is
// computed by diffing against the snapshot taken ~5 minutes earlier. The store lives on
// globalThis so Next.js dev hot-reloads do not wipe the baseline. It is per server
// process: a multi-instance deployment needs a shared store (e.g. Redis) instead.

export type ChainLeg = { ltp: number; oi: number; volume: number; iv: number | null; delta: number | null; trading_symbol: string };
export type ChainRow = { strike: number; ce?: ChainLeg; pe?: ChainLeg };
export type ChainSnapshot = { takenAt: number; spot: number; expiry: string; rows: ChainRow[] };

const TARGET_AGE_MS = 5 * 60 * 1000;
const MIN_AGE_MS = 4 * 60 * 1000;
const MAX_AGE_MS = 12 * 60 * 1000;
const RETENTION_MS = 40 * 60 * 1000;
const MIN_SPACING_MS = 20 * 1000;

const globalStore = globalThis as typeof globalThis & { __tradepulseOiSnapshots?: Map<string, ChainSnapshot[]> };
const store = (globalStore.__tradepulseOiSnapshots ??= new Map<string, ChainSnapshot[]>());

const keyOf = (symbol: string, expiry: string) => `${symbol.toUpperCase()}|${expiry}`;

export function recordSnapshot(symbol: string, snapshot: ChainSnapshot): void {
  const key = keyOf(symbol, snapshot.expiry);
  const history = store.get(key) ?? [];
  const last = history.at(-1);
  if (last && snapshot.takenAt - last.takenAt < MIN_SPACING_MS) history[history.length - 1] = snapshot;
  else history.push(snapshot);
  store.set(key, history.filter((item) => snapshot.takenAt - item.takenAt <= RETENTION_MS));
}

/** The snapshot closest to 5 minutes before `now`, if one between 4 and 12 minutes old exists. */
export function baselineSnapshot(symbol: string, expiry: string, now = Date.now()): ChainSnapshot | null {
  const candidates = (store.get(keyOf(symbol, expiry)) ?? []).filter((item) => {
    const age = now - item.takenAt;
    return age >= MIN_AGE_MS && age <= MAX_AGE_MS;
  });
  if (!candidates.length) return null;
  return candidates.reduce((best, item) => (Math.abs(now - item.takenAt - TARGET_AGE_MS) < Math.abs(now - best.takenAt - TARGET_AGE_MS) ? item : best));
}

/** Seconds of history collected so far, so the UI can show "baseline ready in N min". */
export function snapshotHistorySeconds(symbol: string, expiry: string, now = Date.now()): number {
  const first = store.get(keyOf(symbol, expiry))?.[0];
  return first ? Math.max(0, Math.round((now - first.takenAt) / 1000)) : 0;
}

export function clearSnapshots(): void {
  store.clear();
}
