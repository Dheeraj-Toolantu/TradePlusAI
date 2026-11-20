import { istClock } from "./config";

/**
 * Real-money AUTO execution arming. The trader arms ONE strategy with an exact number of lots,
 * with the trading PIN, for the current IST day. Every auto order uses exactly those lots (never
 * resized); a trade the limits cannot carry at that size is refused. The arming lives only in this
 * server process: it expires at the end of the IST day and on any restart (re-arm to resume), and
 * disarming needs no PIN.
 */
export type AutoStrategy = "NIFTY_SNIPER" | "VWAP_EMA_SCALP";
export type LiveAutoArm = { strategy: AutoStrategy; lots: number; armedAt: string; date: string };

type ArmState = { arm: LiveAutoArm | null; consumed: Map<string, string> };
const holder = globalThis as typeof globalThis & { __tradepulseLiveAutoArm?: ArmState };
const state = (holder.__tradepulseLiveAutoArm ??= { arm: null, consumed: new Map() });

export function setLiveAutoArm(arm: LiveAutoArm | null) { state.arm = arm; }

/** The arming in force now, or null (none, or armed on an earlier IST day). */
export function liveAutoArm(nowMs: number): LiveAutoArm | null {
  if (state.arm && state.arm.date !== istClock(nowMs).date) state.arm = null;
  return state.arm;
}

/** A setup is sent to the broker at most once (retries and the per-minute auto-trader included). */
export function claimLiveSetup(setupId: string, nowMs: number): boolean {
  const today = istClock(nowMs).date;
  for (const [id, date] of state.consumed) if (date !== today) state.consumed.delete(id);
  if (state.consumed.has(setupId)) return false;
  state.consumed.set(setupId, today);
  return true;
}

/** Tests only. */
export function resetLiveAutoArm() { state.arm = null; state.consumed.clear(); }
