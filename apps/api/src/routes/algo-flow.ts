import type { AuthenticatedUser } from "./../middleware/auth";
import { requireRole } from "./../middleware/auth";
import { AlgoFlowService } from "../../../services/strategy/src/algo-flow-service";

const service = new AlgoFlowService();
export function evaluateFlow(user: AuthenticatedUser | undefined, candidateId: string, input: Parameters<AlgoFlowService["evaluate"]>[1]) { requireRole(user, ["ALGO_USER", "RISK_MANAGER", "ADMIN"]); return service.evaluate(candidateId, input, "PAPER", "Paper Broker"); }
export function flowStatus(user: AuthenticatedUser | undefined) { requireRole(user, ["TRADER", "ALGO_USER", "RISK_MANAGER", "ADMIN"]); return service.list(); }