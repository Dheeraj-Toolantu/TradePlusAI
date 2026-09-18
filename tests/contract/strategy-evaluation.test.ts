import { describe, expect, it } from "vitest";
import { evaluateRule } from "../../services/strategy/src/strategy-evaluator";

describe("strategy evaluation contract", () => { it("allows news to gate but never submit", () => { expect(evaluateRule({ type: "NEWS", field: "impact", operator: ">=", value: 80 }, { values: { impact: 90 }, newsCanGate: true })).toBe(true); }); });