import type { AuthenticatedUser } from "../middleware/auth";
import { requireRole } from "../middleware/auth";
import { classifyRegime } from "../../../services/market-regime/src/regime-service";
import { calibrationReport } from "../../../services/news-intelligence/src/calibration-service";

export function intelligenceReadModel(user: AuthenticatedUser | undefined) { requireRole(user, ["TRADER", "STRATEGY_BUILDER", "ALGO_USER", "RISK_MANAGER", "ADMIN"]); return { regime: classifyRegime({ trend: 45, volatility: 35, eventRisk: 10 }), sentiment: "BEARISH", newsImpact: 81, blockers: ["No trade if NIFTY reclaims VWAP"] }; }
export function intelligenceCalibration(user: AuthenticatedUser | undefined) { requireRole(user, ["RISK_MANAGER", "ADMIN"]); return calibrationReport([]); }