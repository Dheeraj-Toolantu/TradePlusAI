import { describe, expect, it } from "vitest";
import { validateStrategy } from "../../services/strategy/src/strategy-schema";

describe("strategy schema", () => {
  it("accepts nested logical rules", () => { expect(validateStrategy({ instruments: ["NIFTY"], timeframes: ["5m"], entry: { type: "AND", children: [{ type: "INDICATOR", field: "vwap", operator: ">=", value: 1 }] }, risk: { riskPercent: 1, minimumRiskReward: 2 }, exits: [] })).toEqual([]); });
  it("rejects empty logical groups", () => { expect(validateStrategy({ instruments: ["NIFTY"], timeframes: ["5m"], entry: { type: "AND", children: [] }, risk: { riskPercent: 1, minimumRiskReward: 2 }, exits: [] })).toContain("AND requires at least one child"); });
});