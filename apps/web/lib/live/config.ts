import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readSafeModeState } from "../../../../services/execution/src/safe-mode";

// Real-money execution is OFF unless every switch below is set on the SERVER. None of these
// can be changed from the browser. Limits are deliberately conservative defaults.
export type LiveConfig = {
  enabled: boolean;
  disabledReasons: string[];
  pinConfigured: boolean;
  limits: {
    maxDailyLoss: number;
    maxTradesPerDay: number;
    maxLotsPerOrder: number;
    maxOrderValue: number;
    maxOpenPositions: number;
    minRewardRisk: number;
  };
  limitBufferPct: number;
  entryWindow: { start: number; end: number };
  squareOffMinute: number;
  confirmTtlSeconds: number;
  killSwitch: boolean;
  safeMode: boolean;
};

const numberFrom = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};
const minuteOf = (value: string | undefined, fallback: string) => {
  const [hours, minutes] = (value ?? fallback).split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : minuteOf(undefined, fallback);
};

export function readLiveConfig(environment: NodeJS.ProcessEnv = process.env): LiveConfig {
  const safety = readSafeModeState(environment);
  const reasons: string[] = [];
  if (environment.EXECUTION_MODE !== "ALGO_LIVE") reasons.push("EXECUTION_MODE is not ALGO_LIVE");
  if (environment.LIVE_EXECUTION_ENABLED !== "true") reasons.push("LIVE_EXECUTION_ENABLED is not true");
  if (environment.LIVE_COMPLIANCE_APPROVED !== "true") reasons.push("LIVE_COMPLIANCE_APPROVED is not true");
  if (environment.LIVE_TRADING_CONFIRMATION !== "true") reasons.push("LIVE_TRADING_CONFIRMATION is not true");
  if (!environment.GROWW_ACCESS_TOKEN && !(environment.GROWW_API_KEY && environment.GROWW_API_SECRET)) reasons.push("Groww API credentials are not configured");
  const pin = environment.LIVE_TRADING_PIN ?? "";
  if (pin.length < 6) reasons.push("LIVE_TRADING_PIN (6+ characters) is not configured");
  if (safety.killSwitch) reasons.push(`KILL_SWITCH active: ${safety.killSwitchReason}`);
  if (safety.safeMode) reasons.push(`SAFE_MODE active: ${safety.safeModeReason}`);
  return {
    enabled: reasons.length === 0,
    disabledReasons: reasons,
    pinConfigured: pin.length >= 6,
    limits: {
      maxDailyLoss: numberFrom(environment.LIVE_MAX_DAILY_LOSS, 2_000, 100, 10_000_000),
      maxTradesPerDay: numberFrom(environment.LIVE_MAX_TRADES_PER_DAY, 3, 1, 50),
      maxLotsPerOrder: numberFrom(environment.LIVE_MAX_LOTS_PER_ORDER, 1, 1, 100),
      maxOrderValue: numberFrom(environment.LIVE_MAX_ORDER_VALUE, 25_000, 500, 100_000_000),
      maxOpenPositions: numberFrom(environment.LIVE_MAX_OPEN_POSITIONS, 1, 1, 20),
      minRewardRisk: numberFrom(environment.LIVE_MIN_REWARD_RISK, 2, 1, 10),
    },
    limitBufferPct: numberFrom(environment.LIVE_LIMIT_BUFFER_PCT, 0.5, 0.05, 3),
    // 09:35 matches the strategy engine, AI advisor and paper traders: the first 20 minutes are
    // opening-auction noise with wide option spreads.
    entryWindow: { start: minuteOf(environment.LIVE_ENTRY_START, "09:35"), end: minuteOf(environment.LIVE_ENTRY_END, "14:45") },
    squareOffMinute: minuteOf(environment.LIVE_SQUARE_OFF, "15:15"),
    confirmTtlSeconds: numberFrom(environment.LIVE_CONFIRM_TTL_SECONDS, 30, 10, 120),
    killSwitch: safety.killSwitch,
    safeMode: safety.safeMode,
  };
}

/** Constant-time PIN check; hashing first makes lengths equal. */
export function pinMatches(candidate: unknown, environment: NodeJS.ProcessEnv = process.env): boolean {
  const pin = environment.LIVE_TRADING_PIN ?? "";
  if (pin.length < 6 || typeof candidate !== "string") return false;
  const expected = createHash("sha256").update(pin).digest();
  const actual = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expected, actual);
}

const secretGlobal = globalThis as typeof globalThis & { __tradepulseLiveSecret?: Buffer };
export function confirmSecret(environment: NodeJS.ProcessEnv = process.env): Buffer {
  if (environment.LIVE_CONFIRM_SECRET && environment.LIVE_CONFIRM_SECRET.length >= 16) return Buffer.from(environment.LIVE_CONFIRM_SECRET);
  return (secretGlobal.__tradepulseLiveSecret ??= randomBytes(32));
}

/** Minutes since midnight IST and the IST calendar date. */
export function istClock(nowMs: number) {
  const shifted = new Date(nowMs + 330 * 60_000);
  return { minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), date: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay() };
}
