import { describe, expect, it } from "vitest";
import { toGrowwOco } from "../../adapters/groww/src/groww-smart-orders";
import { toGrowwOrder, validateReferenceId } from "../../adapters/groww/src/groww-request-policy";

describe("Groww adapter contract", () => {
  it("validates provider reference IDs and maps order fields", () => { expect(validateReferenceId("TP-123456")).toBe("TP-123456"); expect(toGrowwOrder({ referenceId: "TP-123456", symbol: "NIFTY", quantity: 50, side: "BUY", orderType: "MARKET" }).order_reference_id).toBe("TP-123456"); });
  it("rejects OCO quantity greater than net position", () => { expect(() => toGrowwOco({ referenceId: "TP-123456", symbol: "NIFTY", quantity: 100, netPositionQuantity: 50, targetTrigger: 120, stopTrigger: 90 })).toThrow(); });
});