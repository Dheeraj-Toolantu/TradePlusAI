import type { AuthenticatedUser } from "../middleware/auth";
import { requireRole } from "../middleware/auth";

export function operationsReadModel(user: AuthenticatedUser | undefined) { requireRole(user, ["TRADER", "STRATEGY_BUILDER", "ALGO_USER", "RISK_MANAGER", "ADMIN"]); return { notifications: [], journal: [], analytics: { mode: "PAPER", trades: 0 }, audit: [], health: "READY" }; }