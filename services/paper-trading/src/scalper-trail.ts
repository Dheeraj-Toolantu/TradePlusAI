/**
 * The VWAP-EMA scalper's staged trail, in units of the initial premium risk R (entry − initial SL).
 * Pure constants and helpers, safe to import in the browser (no Firestore, no broker code).
 */
export const VWAP_EMA_TRAIL = { breakevenAt: 0.5, lockAt: 1.0, lockTo: 0.5, trailGap: 0.6 } as const;

export type TrailStageName = "INITIAL" | "BREAKEVEN" | "LOCKED" | "TRAILING";

/**
 * What moves the stop next, for display: the premium that triggers the next stage and where the
 * stop goes then. In TRAILING the stop follows the best premium 0.6R behind it.
 */
export function nextTrailStep(input: { entry: number; risk: number; costPerUnit: number; stage: TrailStageName; highWater: number }) {
  const { entry, risk, costPerUnit, stage, highWater } = input;
  if (!(risk > 0)) return null;
  const at = (multiple: number) => Math.round((entry + risk * multiple) * 100) / 100;
  if (stage === "INITIAL") return { trigger: at(VWAP_EMA_TRAIL.breakevenAt), stopTo: Math.round((entry + Math.max(costPerUnit, 0)) * 100) / 100, label: "breakeven + charges" };
  if (stage === "BREAKEVEN") return { trigger: at(VWAP_EMA_TRAIL.lockAt), stopTo: at(VWAP_EMA_TRAIL.lockTo), label: `lock +${VWAP_EMA_TRAIL.lockTo}R` };
  const best = Math.max(highWater, at(VWAP_EMA_TRAIL.lockAt));
  return { trigger: null, stopTo: Math.round((best - risk * VWAP_EMA_TRAIL.trailGap) * 100) / 100, label: `trails ${VWAP_EMA_TRAIL.trailGap}R under the best premium` };
}
