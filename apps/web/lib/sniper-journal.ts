import { doc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

/**
 * NIFTY Sniper AI decision journal (spec 10.2 / 17 audit trail).
 *
 * Every server-side placement attempt writes one immutable record to the `sniperSignals`
 * collection: the setup family, direction, lifecycle, score components, hard filters, V5 gates,
 * the selected contract and the 2x feasibility read, the config version and (when placed) the
 * position. Repeated identical "not confirmed" reads within the same minute are written once.
 * Fire-and-forget: a slow or failing Firestore never blocks or changes a trading decision.
 */

type Analysis = Record<string, unknown>;
export type SniperJournalInput = { underlying: string; origin: string; analysis: Analysis; placed: boolean; reasons: string[]; position?: unknown };

const lastKey = new Map<string, string>();
const clean = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;

export function sniperJournalRecord(input: SniperJournalInput, now = new Date()) {
  const sniper = ((input.analysis.calculations as Analysis | undefined)?.sniper ?? input.analysis.sniper ?? {}) as Analysis;
  const setup = (input.analysis.setup ?? null) as Analysis | null;
  const pipeline = (input.analysis.pipeline ?? null) as Analysis | null;
  const minute = now.toISOString().slice(0, 16);
  const id = `${minute.replace(/[^0-9]/g, "")}-${input.underlying}-${input.placed ? "PLACED" : String(sniper.state ?? input.analysis.decision ?? "NA")}`;
  return {
    id, at: now.toISOString(), underlying: input.underlying, origin: input.origin, placed: input.placed, reasons: input.reasons,
    strategy: "NIFTY_SNIPER", configVersion: sniper.config_version ?? null, configHash: sniper.config_hash ?? null,
    setupType: sniper.setup_type ?? null, entryMode: sniper.entry_mode ?? null, grade: sniper.grade ?? null, reasonCodes: clean(sniper.reason_codes ?? []), orderFlow: clean(sniper.order_flow ?? null), ivCheck: clean(sniper.iv_check ?? null),
    state: sniper.state ?? null, family: sniper.family ?? null, direction: sniper.direction ?? null,
    score: clean(sniper.score), components: clean(sniper.components), hardFilters: clean(sniper.hard_filters), lifecycle: clean(sniper.lifecycle),
    regime: clean(sniper.regime), trigger: clean(sniper.trigger), selected: clean(sniper.selected), feasibility: clean(sniper.feasibility),
    rejectedContracts: clean(sniper.rejected_contracts), strategyReason: input.analysis.strategy_reason ?? input.analysis.reason ?? null,
    pipeline: clean(pipeline), setup: clean(setup), position: clean(input.position ?? null),
  };
}

export async function journalSniper(input: SniperJournalInput) {
  try {
    const record = sniperJournalRecord(input);
    const dedupe = `${record.state}|${record.family}|${record.direction}|${record.placed}|${JSON.stringify(record.reasons)}`;
    if (!input.placed && lastKey.get(input.underlying) === dedupe) return;
    lastKey.set(input.underlying, dedupe);
    if (process.env.VITEST) return;
    await setDoc(doc(db, "sniperSignals", record.id), record);
  } catch (error) {
    console.warn("NIFTY Sniper journal write failed:", error instanceof Error ? error.message : error);
  }
}
