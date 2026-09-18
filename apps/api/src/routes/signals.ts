import type { AuthenticatedUser } from "../middleware/auth";
import { requireRole } from "../middleware/auth";
import type { Signal } from "../../../packages/domain-contracts/src/entities";

export function signalReadModel(user: AuthenticatedUser | undefined, signals: Signal[]) { requireRole(user, ["TRADER", "STRATEGY_BUILDER", "ALGO_USER", "RISK_MANAGER", "ADMIN"]); return signals.map((signal) => ({ ...signal, explainable: true })); }