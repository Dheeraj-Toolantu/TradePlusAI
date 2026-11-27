import { SmartScalper } from "../../../services/paper-trading/src/smart-scalper";

// One process-wide paper scalper book, shared by the scalper desk (/api/scalper) and the algo page's
// "place on scalper" action (/api/algo-trading), so every entry and exit acts on the same positions.
const holder = globalThis as typeof globalThis & { __tradepulseScalper?: SmartScalper };

export function getScalper(): SmartScalper {
  const existing = holder.__tradepulseScalper;
  // The book lives on globalThis so it survives module reloads, but then it would keep running the
  // OLD class code after an update (e.g. "Unknown trailing mode MONEY" from a stale modify()). Move it
  // onto the current class: positions, today's counters and settings are kept; only the methods change.
  if (existing && Object.getPrototypeOf(existing) !== SmartScalper.prototype) Object.setPrototypeOf(existing, SmartScalper.prototype);
  return (holder.__tradepulseScalper ??= new SmartScalper({ slippagePct: Number(process.env.SCALPER_SLIPPAGE_PCT ?? 0.3) / 100 }));
}
