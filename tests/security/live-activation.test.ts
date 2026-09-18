import { describe, expect, it } from "vitest";
import { liveExecutionEnabled } from "../../services/execution/src/live-release-policy";

describe("live activation", () => {
  it("requires both explicit enablement and compliance approval", () => { expect(liveExecutionEnabled({ LIVE_EXECUTION_ENABLED: "true" })).toBe(false); expect(liveExecutionEnabled({ LIVE_EXECUTION_ENABLED: "true", LIVE_COMPLIANCE_APPROVED: "true" })).toBe(true); });
});