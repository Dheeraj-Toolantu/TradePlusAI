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

/**
 * Trailing modes a trader can pick per open position, at any time:
 *  - SMART: the adaptive auto trail below (the default for engine trades).
 *  - RULE: only the position's built-in rule (VWAP-EMA, NIFTY Sniper or the level engine's trail).
 *  - FIXED: the stop follows the best premium a fixed number of rupees (points) behind it.
 *  - OFF: the stop stays where it is put; only the trader moves it.
 */
export type TrailMode = "SMART" | "RULE" | "FIXED" | "OFF";
export const TRAIL_MODES: TrailMode[] = ["SMART", "RULE", "FIXED", "OFF"];

/**
 * Smart auto trail, in units of the position's initial premium risk R. It lets a winner run and
 * gives back less of the open profit the further the trade goes:
 *  - below +0.75R the stop is left alone (no early stop-out on normal noise);
 *  - at +0.75R the stop goes to breakeven + charges;
 *  - from +1.25R it trails the best premium, giving back 45% of the best gain, 33% from +2R,
 *    25% from +3R and 20% from +4R (never closer than 0.3R or two ticks);
 *  - in the last 15 minutes before the square-off the give-back tightens to 15%;
 *  - with runPastTarget, reaching the target does not close the trade: the stop locks 80% of the
 *    move to the target and the target moves out by max(R, half the move), so a trend keeps paying.
 * The stop only ever moves up. These are research defaults, not proven optimal.
 */
export const SMART_TRAIL = {
  breakevenAt: 0.75, trailFrom: 1.25, minGap: 0.3, lateGiveback: 0.15, lateMinutes: 15, lockAtTarget: 0.8,
  giveback: [{ from: 4, keep: 0.2 }, { from: 3, keep: 0.25 }, { from: 2, keep: 0.33 }, { from: 0, keep: 0.45 }],
} as const;

export type SmartTrailInput = {
  entry: number;
  stop: number | null;
  target: number | null;
  highWater: number;
  /** Current premium (net value for a spread). */
  value: number;
  /** Initial premium risk per unit (R). */
  risk: number;
  costPerUnit: number;
  tick?: number;
  /** Minutes left to the square-off (late-session tightening). */
  minutesToClose?: number;
  runPastTarget: boolean;
  stage: TrailStageName;
};

export function smartGiveback(gainR: number, minutesToClose?: number) {
  const base = SMART_TRAIL.giveback.find((step) => gainR >= step.from)?.keep ?? 0.45;
  return minutesToClose !== undefined && minutesToClose <= SMART_TRAIL.lateMinutes ? Math.min(base, SMART_TRAIL.lateGiveback) : base;
}

export function smartTrail(input: SmartTrailInput) {
  const { entry, highWater, value, risk, runPastTarget } = input;
  const tick = input.tick && input.tick > 0 ? input.tick : 0.05;
  const down = (price: number) => Math.round(Math.floor(price / tick + 1e-6) * tick * 100) / 100;
  let stop = input.stop;
  let target = input.target;
  let stage: TrailStageName = input.stage;
  let extended = false;
  if (!(risk > 0) || !(entry > 0)) return { stop, target, stage, extended };
  const raise = (price: number) => { const next = down(price); if (stop === null || next > stop) stop = next; };
  const gain = highWater - entry;
  if (gain >= risk * SMART_TRAIL.breakevenAt) { raise(entry + Math.max(input.costPerUnit, 0)); if (stage === "INITIAL") stage = "BREAKEVEN"; }
  if (gain >= risk * SMART_TRAIL.trailFrom) {
    const gap = Math.max(gain * smartGiveback(gain / risk, input.minutesToClose), risk * SMART_TRAIL.minGap, tick * 2);
    raise(highWater - gap);
    stage = gain >= risk * 2 ? "TRAILING" : stage === "TRAILING" ? "TRAILING" : "LOCKED";
  }
  // Let the winner run: on the target, lock most of the move and push the target out.
  if (runPastTarget && target !== null && target > entry && value >= target) {
    const move = target - entry;
    raise(Math.min(entry + move * SMART_TRAIL.lockAtTarget, value - tick));
    target = Math.round(Math.ceil((target + Math.max(risk, move * 0.5)) / tick - 1e-6) * tick * 100) / 100;
    extended = true;
    if (stage !== "TRAILING") stage = "LOCKED";
  }
  return { stop: stop === null ? null : Math.round(stop * 100) / 100, target, stage, extended };
}

/** Display helper for the smart trail (what moves the stop next). */
export function nextSmartTrailStep(input: { entry: number; risk: number; costPerUnit: number; stage: TrailStageName; highWater: number; minutesToClose?: number }) {
  const { entry, risk, costPerUnit, stage, highWater } = input;
  if (!(risk > 0)) return null;
  const at = (multiple: number) => Math.round((entry + risk * multiple) * 100) / 100;
  if (stage === "INITIAL") return { trigger: at(SMART_TRAIL.breakevenAt), stopTo: Math.round((entry + Math.max(costPerUnit, 0)) * 100) / 100, label: "breakeven + charges at +0.75R" };
  if (highWater - entry < risk * SMART_TRAIL.trailFrom) return { trigger: at(SMART_TRAIL.trailFrom), stopTo: Math.round((at(SMART_TRAIL.trailFrom) - risk * SMART_TRAIL.trailFrom * 0.45) * 100) / 100, label: "smart trail starts at +1.25R" };
  const gain = highWater - entry;
  const keep = smartGiveback(gain / risk, input.minutesToClose);
  return { trigger: null, stopTo: Math.round((highWater - Math.max(gain * keep, risk * SMART_TRAIL.minGap)) * 100) / 100, label: `smart trail gives back ${Math.round(keep * 100)}% of the best gain` };
}
