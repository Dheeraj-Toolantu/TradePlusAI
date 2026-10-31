import { SmartScalper } from "../../../services/paper-trading/src/smart-scalper";

// One process-wide paper scalper book, shared by the scalper desk (/api/scalper) and the algo page's
// "place on scalper" action (/api/algo-trading), so every entry and exit acts on the same positions.
const holder = globalThis as typeof globalThis & { __tradepulseScalper?: SmartScalper };

export function getScalper(): SmartScalper {
  return (holder.__tradepulseScalper ??= new SmartScalper({ slippagePct: Number(process.env.SCALPER_SLIPPAGE_PCT ?? 0.3) / 100 }));
}
