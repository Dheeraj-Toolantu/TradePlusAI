import type { AuthenticatedUser } from "../middleware/auth";
import { requireRole } from "../middleware/auth";
import { liveExecutionEnabled } from "../../../services/execution/src/live-release-policy";

export function executionReadModel(user: AuthenticatedUser | undefined) { requireRole(user, ["ALGO_USER", "RISK_MANAGER", "ADMIN"]); return { liveEnabled: liveExecutionEnabled(), mode: "PAPER", broker: "Groww", health: "DISCONNECTED", killSwitch: false }; }