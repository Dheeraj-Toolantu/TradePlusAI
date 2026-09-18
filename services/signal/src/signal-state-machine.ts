const transitions: Record<string, string[]> = {
  NO_SETUP: ["WATCHING"], WATCHING: ["PRE_ENTRY", "INVALIDATED"], PRE_ENTRY: ["ENTRY_CONFIRMED", "INVALIDATED", "RISK_BREACH"],
  ENTRY_CONFIRMED: ["ORDER_PENDING", "RISK_BREACH", "EMERGENCY_STOP"], ORDER_PENDING: ["FILLED", "INVALIDATED", "EMERGENCY_STOP"], FILLED: ["TARGET_1", "TARGET_2", "TRAILING", "EXITED", "EMERGENCY_STOP"],
  TARGET_1: ["TARGET_2", "TRAILING", "EXITED"], TARGET_2: ["EXITED"], TRAILING: ["TRAILING", "EXITED"], INVALIDATED: ["EXITED"], RISK_BREACH: ["EXITED"], EMERGENCY_STOP: ["EXITED"], EXITED: [],
};

export function transitionSignal(current: string, next: string): string {
  if (!transitions[current]?.includes(next)) throw new Error(`Invalid signal transition: ${current} -> ${next}`);
  return next;
}

export function transitionWithAudit(current: string, next: string, actor: string) {
  return { from: current, to: transitionSignal(current, next), actor, occurredAt: new Date().toISOString() };
}