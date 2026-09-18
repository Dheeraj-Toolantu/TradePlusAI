import type { AuthenticatedUser } from "../middleware/auth";
import { requireRole } from "../middleware/auth";

export function dashboardReadModel(user: AuthenticatedUser | undefined) {
  requireRole(user, ["TRADER", "STRATEGY_BUILDER", "ALGO_USER", "RISK_MANAGER", "ADMIN"]);
  return { mode: "PAPER", marketFreshness: "FRESH", brokerHealth: "DISCONNECTED", riskStatus: "READY", blockers: [] as string[] };
}