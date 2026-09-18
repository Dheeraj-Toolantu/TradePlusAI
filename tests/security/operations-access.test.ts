import { describe, expect, it } from "vitest";
import { requireRole } from "../../apps/api/src/middleware/auth";

describe("operations access", () => { it("limits protected operations to authorized roles", () => { expect(requireRole({ id: "u1", role: "ADMIN" }, ["ADMIN"]).id).toBe("u1"); expect(() => requireRole({ id: "u2", role: "TRADER" }, ["ADMIN"])).toThrow(); }); });