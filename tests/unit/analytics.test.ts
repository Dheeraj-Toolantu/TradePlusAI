import { describe, expect, it } from "vitest";
import { aggregatePerformance } from "../../services/audit/src/analytics-service";

describe("analytics", () => { it("labels mode and computes core metrics", () => { const result = aggregatePerformance([1, -0.5, 2], "PAPER"); expect(result.mode).toBe("PAPER"); expect(result.winRate).toBeCloseTo(2 / 3); expect(result.maxDrawdown).toBe(0.5); }); });