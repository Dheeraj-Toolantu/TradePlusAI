import { describe, expect, it } from "vitest";
import { safeStateForFailure } from "../../services/risk/src/safe-state";

describe("safe-state workflow", () => { it("blocks new entries on critical failures", () => { expect(safeStateForFailure("BROKER_DISCONNECTED").state).toBe("BLOCK_NEW_ENTRIES"); expect(safeStateForFailure("PROTECTION_FAILED").state).toBe("EMERGENCY_PROTECTION"); }); });