import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, where } from "firebase/firestore";
import { db } from "./firebase";
import type { IndexSentiment } from "./index-sentiment";

/**
 * Sentiment history in Firestore.
 *
 * - `sentimentSnapshots/{id}`: every index (NIFTY 50, BANK NIFTY, SENSEX) and commodity (crude oil,
 *   natural gas, gold, silver, copper) score, label and price. One per 15-minute IST slot (id
 *   `20261021-0915`), plus one as soon as a reversal is seen (id `20261021-0922-reversal`).
 * - `sentimentReversals/{id}`: one document per reversal.
 * - `sentimentState/latest`: the last direction of every instrument, so a restart neither misses
 *   nor double-counts a reversal.
 *
 * A reversal is a flip of sentiment direction (score crossing from >= +10 to <= -10 or back; the
 * band in between keeps the previous direction, so a score wobbling around zero is not a flip) or
 * of the day's price move (from >= +0.2% to <= -0.2% or back).
 */
export const SNAPSHOTS = "sentimentSnapshots";
export const REVERSALS = "sentimentReversals";
const STATE = "sentimentState";
export const SLOT_MINUTES = 15;
export const SENTIMENT_BAND = 10;
export const PRICE_BAND_PCT = 0.2;

export type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";
export type PriceDirection = "UP" | "DOWN" | "FLAT";
export type Instrument = { id: string; kind: "INDEX" | "COMMODITY"; name: string; score: number | null; label: string; price: number | null; change_pct: number | null; extra: Record<string, unknown> };
export type InstrumentState = { sentiment: Direction; price: PriceDirection; score: number | null; change_pct: number | null; at: string };
export type Reversal = {
  id: string; instrument: string; name: string; kind: Instrument["kind"]; type: "SENTIMENT" | "PRICE";
  from: string; to: string; previous_score: number | null; score: number | null; previous_change_pct: number | null; change_pct: number | null;
  price: number | null; previous_at: string; at: string; scan_at: string;
};
export type HistoryState = { lastSlot: string | null; lastScanAt: string | null; instruments: Record<string, InstrumentState> };
export type RecordResult = { recorded: boolean; snapshotId: string | null; reasons: Array<"SCHEDULED" | "REVERSAL">; reversals: Reversal[]; scanAt: string | null; error?: string };

const round = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

/** "20261021-0915": the 15-minute slot in IST that `at` falls in (`step` 1 gives the IST minute). */
export function slotId(at: Date, step = SLOT_MINUTES): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const minutes = Math.floor(ist.getUTCMinutes() / step) * step;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${ist.getUTCFullYear()}${pad(ist.getUTCMonth() + 1)}${pad(ist.getUTCDate())}-${pad(ist.getUTCHours())}${pad(minutes)}`;
}

/** "2026-10-21" and "09:26" in IST: stored on every document so the history can be read by day. */
export const istDate = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
export const istTime = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(11, 16);

export function sentimentDirection(score: number | null, previous: Direction = "NEUTRAL"): Direction {
  if (score === null) return previous;
  return score >= SENTIMENT_BAND ? "BULLISH" : score <= -SENTIMENT_BAND ? "BEARISH" : previous;
}

export function priceDirection(changePct: number | null, previous: PriceDirection = "FLAT"): PriceDirection {
  if (changePct === null) return previous;
  return changePct >= PRICE_BAND_PCT ? "UP" : changePct <= -PRICE_BAND_PCT ? "DOWN" : previous;
}

/** Indices and commodities from a scan, flattened to what is stored. */
export function instrumentsOf(scan: IndexSentiment): Instrument[] {
  const indices: Instrument[] = scan.indices.map((index) => ({
    id: index.id, kind: "INDEX", name: index.name, score: round(index.score, 1), label: index.label, price: round(index.quote?.price), change_pct: round(index.quote?.change_pct),
    extra: { zone: index.zone, bias: index.bias, bullish_pct: round(index.breadth.bullish_pct, 1), bearish_pct: round(index.breadth.bearish_pct, 1),
      advances: index.breadth.advances, declines: index.breadth.declines, stocks_scored: index.coverage.stocks_scored, stocks_total: index.coverage.stocks_total,
      // Every constituent's price and score at this time (~50 rows, a few KB per snapshot).
      constituents: (index.constituents ?? []).map((stock) => ({ symbol: stock.symbol, name: stock.name, weight: round(stock.weight), score: round(stock.score, 1), label: stock.label,
        price: round(stock.price), change_pct: round(stock.change_pct) })) },
  }));
  const commodities: Instrument[] = (scan.commodities?.commodities ?? []).map((item) => ({
    id: item.id, kind: "COMMODITY", name: item.name, score: round(item.score, 1), label: item.label, price: round(item.price, 3), change_pct: round(item.change_pct),
    extra: { unit: item.unit, india_impact: round(item.india_impact, 1), india_label: item.india_label, five_day_pct: round(item.five_day_pct), lenses: item.lenses },
  }));
  return [...indices, ...commodities];
}

/** Reversals between the stored state and this scan, and the state to store next. */
export function detectReversals(instruments: Instrument[], state: HistoryState, scanAt: string): { reversals: Reversal[]; next: Record<string, InstrumentState> } {
  const reversals: Reversal[] = [];
  const next: Record<string, InstrumentState> = { ...state.instruments };
  for (const item of instruments) {
    const before = state.instruments[item.id];
    const sentiment = sentimentDirection(item.score, before?.sentiment);
    const price = priceDirection(item.change_pct, before?.price);
    if (before) {
      const base = { instrument: item.id, name: item.name, kind: item.kind, previous_score: before.score, score: item.score, previous_change_pct: before.change_pct,
        change_pct: item.change_pct, price: item.price, previous_at: before.at, at: scanAt, scan_at: scanAt };
      if (before.sentiment !== "NEUTRAL" && sentiment !== before.sentiment) reversals.push({ ...base, id: `${item.id}-SENTIMENT-${scanAt}`, type: "SENTIMENT", from: before.sentiment, to: sentiment });
      if (before.price !== "FLAT" && price !== before.price) reversals.push({ ...base, id: `${item.id}-PRICE-${scanAt}`, type: "PRICE", from: before.price, to: price });
    }
    next[item.id] = { sentiment, price, score: item.score, change_pct: item.change_pct, at: scanAt };
  }
  return { reversals, next };
}

const store = globalThis as typeof globalThis & { __tradepulseSentimentHistory?: HistoryState | null; __tradepulseSentimentRecording?: Promise<RecordResult> | null };
const firestoreId = (value: string) => value.replace(/[/.:+]/g, "-");

async function loadState(): Promise<HistoryState> {
  if (store.__tradepulseSentimentHistory) return store.__tradepulseSentimentHistory;
  const snapshot = await getDoc(doc(db, STATE, "latest"));
  const data = snapshot.exists() ? (snapshot.data() as Partial<HistoryState>) : {};
  return { lastSlot: data.lastSlot ?? null, lastScanAt: data.lastScanAt ?? null, instruments: data.instruments ?? {} };
}

async function record(scan: IndexSentiment, now: Date): Promise<RecordResult> {
  const state = await loadState();
  const scanAt = scan.generated_at;
  const instruments = instrumentsOf(scan);
  // A reversal can only show up in a new scan; the same scan is never compared twice.
  const { reversals, next } = scanAt !== state.lastScanAt ? detectReversals(instruments, state, scanAt) : { reversals: [], next: state.instruments };
  const slot = slotId(now);
  const reasons: RecordResult["reasons"] = [];
  if (slot !== state.lastSlot) reasons.push("SCHEDULED");
  if (reversals.length) reasons.push("REVERSAL");
  const nextState: HistoryState = { lastSlot: reasons.includes("SCHEDULED") ? slot : state.lastSlot, lastScanAt: scanAt, instruments: next };
  if (!reasons.length) {
    store.__tradepulseSentimentHistory = nextState;
    return { recorded: false, snapshotId: null, reasons, reversals, scanAt };
  }
  const snapshotId = reasons.includes("SCHEDULED") ? slot : `${slotId(now, 1)}-reversal`;
  const recordedAt = now.toISOString();
  await setDoc(doc(db, SNAPSHOTS, snapshotId), {
    id: snapshotId, slot, date: istDate(now), time: istTime(now), recordedAt, scanAt, reasons,
    reversals: reversals.map((item) => ({ instrument: item.instrument, type: item.type, from: item.from, to: item.to })),
    indices: Object.fromEntries(instruments.filter((item) => item.kind === "INDEX").map((item) => [item.id, { name: item.name, score: item.score, label: item.label, price: item.price, change_pct: item.change_pct, ...item.extra }])),
    commodities: Object.fromEntries(instruments.filter((item) => item.kind === "COMMODITY").map((item) => [item.id, { name: item.name, score: item.score, label: item.label, price: item.price, change_pct: item.change_pct, ...item.extra }])),
  }, { merge: true });
  for (const reversal of reversals) await setDoc(doc(db, REVERSALS, firestoreId(reversal.id)), { ...reversal, date: istDate(now), time: istTime(now), recordedAt, snapshotId });
  await setDoc(doc(db, STATE, "latest"), { ...nextState, updatedAt: recordedAt });
  store.__tradepulseSentimentHistory = nextState;
  return { recorded: true, snapshotId, reasons, reversals, scanAt };
}

/**
 * Store a snapshot if this 15-minute slot has none yet or the latest scan shows a reversal.
 * Meant to be called about once a minute (the API server does); calls in between are cheap no-ops.
 */
export function recordSentiment(scan: IndexSentiment, now = new Date()): Promise<RecordResult> {
  store.__tradepulseSentimentRecording ??= record(scan, now).finally(() => { store.__tradepulseSentimentRecording = null; });
  return store.__tradepulseSentimentRecording;
}

/** Test hook: forget the cached state so the next call reads Firestore again. */
export function resetSentimentHistoryCache(): void {
  store.__tradepulseSentimentHistory = null;
  store.__tradepulseSentimentRecording = null;
}

export type HistoryReading = { name: string; score: number | null; label: string; price: number | null; change_pct: number | null; [key: string]: unknown };
export type StoredConstituent = { symbol: string; name: string; weight: number | null; score: number | null; label: string; price: number | null; change_pct: number | null };
export type StoredSnapshot = {
  id: string; slot: string; date?: string; time?: string; recordedAt: string; scanAt: string; reasons: Array<"SCHEDULED" | "REVERSAL">;
  reversals: Array<{ instrument: string; type: Reversal["type"]; from: string; to: string }>;
  indices: Record<string, HistoryReading & { zone?: string; bullish_pct?: number | null; bearish_pct?: number | null; advances?: number; declines?: number; constituents?: StoredConstituent[] }>;
  commodities: Record<string, HistoryReading & { unit?: string; india_impact?: number | null; india_label?: string }>;
};
export type StoredReversal = Reversal & { date?: string; time?: string; recordedAt: string; snapshotId: string };

const newestFirst = <T extends { recordedAt?: unknown }>(rows: T[]) => rows.sort((a, b) => String(b.recordedAt ?? "").localeCompare(String(a.recordedAt ?? "")));

/**
 * Latest snapshots and reversals, newest first. With `date` ("2026-10-21", IST) only that day's,
 * read by an equality filter and sorted here, so Firestore needs no composite index.
 */
export async function recentHistory(count = 20, date?: string): Promise<{ snapshots: StoredSnapshot[]; reversals: StoredReversal[] }> {
  const size = Math.max(1, Math.min(200, count));
  const read = async <T,>(name: string) => {
    const result = await getDocs(date ? query(collection(db, name), where("date", "==", date)) : query(collection(db, name), orderBy("recordedAt", "desc"), limit(size)));
    const rows = result.docs.map((item) => ({ ...item.data(), id: item.id }) as { id: string; recordedAt?: unknown });
    return newestFirst(rows).slice(0, date ? 200 : size) as unknown as T[];
  };
  const [snapshots, reversals] = await Promise.all([read<StoredSnapshot>(SNAPSHOTS), read<StoredReversal>(REVERSALS)]);
  return { snapshots, reversals };
}
