import { describe, expect, it } from "vitest";
import { evaluateOutcome, OUTCOME_HORIZONS } from "../../services/news-intelligence/src/outcome-evaluator";

describe("news outcome horizons", () => { it("evaluates all six horizons", () => { expect(OUTCOME_HORIZONS).toEqual(["1m", "5m", "15m", "30m", "1h", "1d"]); expect(evaluateOutcome(100, 105)).toBe(5); }); });