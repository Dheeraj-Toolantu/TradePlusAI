import { describe, expect, it } from "vitest";
import { assertMutable, createStrategyVersion } from "../../services/strategy/src/strategy-version-service";

const definition = { instruments: ["NIFTY"], timeframes: ["5m"], entry: { type: "INDICATOR" as const, field: "vwap", operator: ">=", value: 1 }, risk: { riskPercent: 1, minimumRiskReward: 2 }, exits: [] };

describe("strategy versions", () => {
  it("increments versions and prevents live edits", () => { const version = createStrategyVersion(undefined, definition, "user-1"); const live = { ...version, promotionState: "ALGO_LIVE_CAPPED", immutable: true }; expect(() => assertMutable(live)).toThrow(); });
});