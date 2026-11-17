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

/**
 * NIFTY Sniper AI staged trail, in MULTIPLES OF THE ACTUAL ENTRY PREMIUM P0 (spec 13.4):
 * before 1.25x the initial stop holds; at 1.25x the stop moves to breakeven + charges; at 1.5x it
 * locks 1.2x; from 1.75x it trails 0.2·P0 under the best premium; 2.0x is the target (closes).
 * These stages are research defaults, not proven optimal: compare them against a fixed target in
 * backtests before relying on them.
 */
export const SNIPER_TRAIL = { breakevenAt: 1.25, lockAt: 1.5, lockTo: 1.2, tightenAt: 1.75, trailGap: 0.2 } as const;

export function sniperTrail(position: { entry: number; stop: number; highWater: number; trail: { costPerUnit: number; stage: TrailStageName } }) {
  const { entry, highWater } = position;
  let stop = position.stop;
  let stage: TrailStageName = position.trail.stage;
  if (!(entry > 0)) return { stop, stage };
  const multiple = highWater / entry;
  if (multiple >= SNIPER_TRAIL.breakevenAt) { stop = Math.max(stop, entry + Math.max(position.trail.costPerUnit, 0)); if (stage === "INITIAL") stage = "BREAKEVEN"; }
  if (multiple >= SNIPER_TRAIL.lockAt) { stop = Math.max(stop, entry * SNIPER_TRAIL.lockTo); if (stage === "INITIAL" || stage === "BREAKEVEN") stage = "LOCKED"; }
  if (multiple >= SNIPER_TRAIL.tightenAt) {
    const trailed = highWater - entry * SNIPER_TRAIL.trailGap;
    if (trailed > stop) { stop = trailed; stage = "TRAILING"; }
  }
  return { stop: Math.round(stop * 100) / 100, stage };
}

/** Display helper for the sniper trail (what moves the stop next). */
export function nextSniperTrailStep(input: { entry: number; costPerUnit: number; stage: TrailStageName; highWater: number }) {
  const { entry, costPerUnit, stage, highWater } = input;
  if (!(entry > 0)) return null;
  const at = (multiple: number) => Math.round(entry * multiple * 100) / 100;
  if (stage === "INITIAL") return { trigger: at(SNIPER_TRAIL.breakevenAt), stopTo: Math.round((entry + Math.max(costPerUnit, 0)) * 100) / 100, label: "breakeven + charges at 1.25x" };
  if (stage === "BREAKEVEN") return { trigger: at(SNIPER_TRAIL.lockAt), stopTo: at(SNIPER_TRAIL.lockTo), label: `lock ${SNIPER_TRAIL.lockTo}x at 1.5x` };
  if (stage === "LOCKED") return { trigger: at(SNIPER_TRAIL.tightenAt), stopTo: at(SNIPER_TRAIL.tightenAt - SNIPER_TRAIL.trailGap), label: "tighten the trail at 1.75x" };
  return { trigger: null, stopTo: Math.round((Math.max(highWater, at(SNIPER_TRAIL.tightenAt)) - entry * SNIPER_TRAIL.trailGap) * 100) / 100, label: `trails ${SNIPER_TRAIL.trailGap}x P0 under the best premium; exits at 2x` };
}
