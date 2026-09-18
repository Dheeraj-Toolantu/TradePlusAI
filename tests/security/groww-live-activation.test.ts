import { describe, expect, it } from "vitest";
import { liveExecutionEnabled } from "../../services/execution/src/live-release-policy";

describe("Groww live activation", () => { it("requires explicit compliance and enablement", () => { expect(liveExecutionEnabled({ LIVE_EXECUTION_ENABLED: "true" })).toBe(false); expect(liveExecutionEnabled({ LIVE_EXECUTION_ENABLED: "true", LIVE_COMPLIANCE_APPROVED: "true" })).toBe(true); }); });