import type { Mode } from "./primitives";

export type ExecutionCapability = "PAPER_SIMULATE" | "BROKER_SUBMIT" | "BROKER_CANCEL" | "BROKER_MODIFY";
export const MODE_CAPABILITIES: Record<Mode, readonly ExecutionCapability[]> = { PAPER: ["PAPER_SIMULATE"], ASSISTED: ["BROKER_SUBMIT", "BROKER_CANCEL", "BROKER_MODIFY"], ALGO_LIVE: ["BROKER_SUBMIT", "BROKER_CANCEL", "BROKER_MODIFY"] };
export function modeCan(mode: Mode, capability: ExecutionCapability) { return MODE_CAPABILITIES[mode].includes(capability); }
export function livePreconditions(environment: NodeJS.ProcessEnv = process.env) { return environment.LIVE_EXECUTION_ENABLED === "true" && environment.LIVE_COMPLIANCE_APPROVED === "true"; }