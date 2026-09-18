import { describe, expect, it } from "vitest";
import { safeStateForFailure } from "../../services/risk/src/safe-state";
import { liveExecutionEnabled } from "../../services/execution/src/live-release-policy";

describe("Groww fail-closed paths", () => { it("blocks unsafe provider states and default live flags", () => { expect(safeStateForFailure("BROKER_DISCONNECTED").state).toBe("BLOCK_NEW_ENTRIES"); expect(safeStateForFailure("PROTECTION_FAILED").state).toBe("EMERGENCY_PROTECTION"); expect(liveExecutionEnabled({})).toBe(false); }); });