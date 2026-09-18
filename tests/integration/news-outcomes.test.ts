import { describe, expect, it } from "vitest";
import { evaluateOutcome, OUTCOME_HORIZONS } from "../../services/news-intelligence/src/outcome-evaluator";

describe("news outcome horizons", () => { it("supports all required horizons", () => { expect(OUTCOME_HORIZONS).toHaveLength(6); expect(evaluateOutcome(100, 105)).toBe(5); }); });