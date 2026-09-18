import type { AuthenticatedUser } from "../middleware/auth";
import { requireRole } from "../middleware/auth";
import type { Strategy } from "../../../packages/domain-contracts/src/entities";

export function strategyReadModel(user: AuthenticatedUser | undefined, strategies: Strategy[]) { requireRole(user, ["STRATEGY_BUILDER", "ALGO_USER", "RISK_MANAGER", "ADMIN"]); return strategies; }