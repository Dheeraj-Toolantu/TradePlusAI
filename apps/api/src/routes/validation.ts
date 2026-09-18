import type { AuthenticatedUser } from "../middleware/auth";
import { requireRole } from "../middleware/auth";
import { createBacktestRun } from "../../../services/backtest/src/backtest-service";

export function validationReadModel(user: AuthenticatedUser | undefined, strategyVersion: string, returns: number[]) { requireRole(user, ["STRATEGY_BUILDER", "ALGO_USER", "RISK_MANAGER", "ADMIN"]); return createBacktestRun(strategyVersion, returns); }