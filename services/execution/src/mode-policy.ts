import type { Mode } from "../../../packages/domain-contracts/src/primitives";

export type Capability = "SIMULATE_ORDER" | "CONFIRM_ORDER" | "SUBMIT_ORDER" | "MODIFY_ORDER" | "CANCEL_ORDER";

const capabilities: Record<Mode, ReadonlySet<Capability>> = {
  PAPER: new Set(["SIMULATE_ORDER"]),
  ASSISTED: new Set(["CONFIRM_ORDER", "SUBMIT_ORDER", "MODIFY_ORDER", "CANCEL_ORDER"]),
  ALGO_LIVE: new Set(["SUBMIT_ORDER", "MODIFY_ORDER", "CANCEL_ORDER"]),
};

export function canUseCapability(mode: Mode, capability: Capability): boolean {
  return capabilities[mode].has(capability);
}

export function assertPaperIsolation(mode: Mode, endpoint: "SIMULATOR" | "BROKER"): void {
  if (mode === "PAPER" && endpoint !== "SIMULATOR") throw new Error("Paper mode cannot access broker endpoints");
}