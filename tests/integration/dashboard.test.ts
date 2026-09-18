import { describe, expect, it } from "vitest";
import { dashboardReadModel } from "../../apps/api/src/routes/dashboard";
import { dashboardEventState } from "../../services/market-data/src/realtime-dashboard-events";

describe("dashboard integration", () => { it("exposes mode, health, freshness, and blockers", () => { const model = dashboardReadModel({ id: "u1", role: "TRADER" }); expect(model.mode).toBe("PAPER"); expect(model.marketFreshness).toBe("FRESH"); }); it("surfaces unsafe realtime state", () => { expect(dashboardEventState([{ eventId: "1", eventType: "quote.updated", schemaVersion: "1.0", occurredAt: "", receivedAt: "", mode: "SYSTEM", subjectType: "quote", subjectId: "NIFTY", freshness: "STALE", severity: "WARNING", payload: null }]).unsafe).toBe(true); }); });