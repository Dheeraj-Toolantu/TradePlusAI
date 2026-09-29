import { runPythonModule } from "./python";

export type MacroQuote = { price: number; previous_close: number; change_pct: number };
type MacroScan = { quotes: Record<string, MacroQuote> };

// Crude, dollar, rupee, US futures and Asian indices: one scan per 5 minutes per server,
// stale-while-revalidate so the 30-second intel poll never waits on 11 public quote feeds.
const TTL_MS = 5 * 60_000;
const store = globalThis as typeof globalThis & { __tradepulseMacro?: { at: number; value: MacroScan } | null; __tradepulseMacroJob?: Promise<MacroScan> | null };

function refresh(): Promise<MacroScan> {
  store.__tradepulseMacroJob ??= runPythonModule<MacroScan>("tradepulse_quant.market_intel.macro", {}, 20_000)
    .then((value) => { store.__tradepulseMacro = { at: Date.now(), value }; return value; })
    .finally(() => { store.__tradepulseMacroJob = null; });
  return store.__tradepulseMacroJob;
}

/** Latest macro quotes keyed by instrument id, or null while the first scan is still running. */
export async function getMacroQuotes(): Promise<Record<string, MacroQuote> | null> {
  const cached = store.__tradepulseMacro;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value.quotes;
  const job = refresh();
  job.catch(() => undefined);
  return cached?.value.quotes ?? null;
}
