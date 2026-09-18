import type { BrokerAdapter } from "../../../packages/broker-contracts/src/broker-adapter";
import { liveExecutionEnabled } from "./live-release-policy";

export function selectExecutionTarget(mode: "PAPER" | "ASSISTED" | "ALGO_LIVE", paper: BrokerAdapter, groww: BrokerAdapter): BrokerAdapter {
  if (mode === "PAPER") return paper;
  if (!liveExecutionEnabled()) throw new Error("Live execution requires explicit compliance approval and enablement");
  return groww;
}