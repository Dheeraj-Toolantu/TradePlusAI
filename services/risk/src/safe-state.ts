export type SafeState = "READY" | "BLOCK_NEW_ENTRIES" | "EMERGENCY_PROTECTION" | "KILL_SWITCH";

export type SafeStateReason = { state: SafeState; reason: string; occurredAt: string };

export function safeStateForFailure(failure: "STALE_DATA" | "RISK_UNAVAILABLE" | "BROKER_DISCONNECTED" | "PROTECTION_FAILED" | "KILL_SWITCH"): SafeStateReason {
  const state = failure === "PROTECTION_FAILED" ? "EMERGENCY_PROTECTION" : failure === "KILL_SWITCH" ? "KILL_SWITCH" : "BLOCK_NEW_ENTRIES";
  return { state, reason: failure, occurredAt: new Date().toISOString() };
}