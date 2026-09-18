import { describe, expect, it } from "vitest";
import { AuditService } from "../../services/audit/src/audit-service";
import { projectTradeJournal } from "../../services/audit/src/trade-journal";

describe("audit journal", () => { it("keeps a complete decision trace", () => { const journal = projectTradeJournal({ signalId: "s1", strategyVersion: "strategy:1", riskDecision: "risk-1", orderId: "order-1", fills: ["fill-1"], exit: "stop", outcome: -1, rationale: "VWAP rejection" }); const audit = new AuditService(); audit.append({ actor: "system", action: "ORDER_BLOCKED", objectType: "Order", objectId: journal.orderId!, reason: journal.rationale }); expect(audit.list()).toHaveLength(1); expect(journal.fills).toContain("fill-1"); }); });