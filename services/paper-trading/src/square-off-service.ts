import type { PaperAccount } from "./paper-repository";

export type SquareOffDecision = { action: "SQUARE_OFF" | "HOLD"; reason: string; positions: number; timestamp: string };

export function evaluateEndOfDay(account: PaperAccount, now: Date, policy: { enabled: boolean; cutoffHour: number }): SquareOffDecision {
  const positions = account.orders.filter((order) => order.status === "FILLED").length;
  const isAfterCutoff = now.getHours() >= policy.cutoffHour;
  return { action: policy.enabled && isAfterCutoff && positions > 0 ? "SQUARE_OFF" : "HOLD", reason: policy.enabled && isAfterCutoff ? "Configured end-of-day policy" : "End-of-day policy not active", positions, timestamp: now.toISOString() };
}