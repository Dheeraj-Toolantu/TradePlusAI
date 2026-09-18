import { describe, expect, it } from "vitest";
import { entryAllowedDuringEvent } from "../../services/market-regime/src/event-risk-policy";
import { classifyRegime } from "../../services/market-regime/src/regime-service";

describe("market regime", () => {
  it("prioritizes event risk and blackout windows", () => { expect(classifyRegime({ trend: 90, volatility: 20, eventRisk: 90 })).toBe("EVENT_RISK"); expect(entryAllowedDuringEvent("HIGH", false, false)).toBe(false); expect(entryAllowedDuringEvent("LOW", true, true)).toBe(false); });
});