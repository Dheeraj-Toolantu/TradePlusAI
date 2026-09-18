export function remainingProtectionQuantity(orderQuantity: number, filledQuantity: number): number {
  return Math.max(0, Math.min(orderQuantity, filledQuantity));
}

export function protectionFailureAction(): "EMERGENCY_PROTECTION" { return "EMERGENCY_PROTECTION"; }

export function updateProtectionAfterPartialFill(plan: { quantity: number; filledQuantity: number }) { return { ...plan, quantity: remainingProtectionQuantity(plan.quantity, plan.filledQuantity), status: plan.filledQuantity > 0 ? "READY" : "PENDING" }; }