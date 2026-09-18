import { describe, expect, it } from "vitest";
import { isUnsafeEvent } from "../../packages/event-schemas/src/events";
import { redactSecrets } from "../../services/audit/src/security-logging";
import { assertPaperIsolation, canUseCapability } from "../../services/execution/src/mode-policy";

describe("foundation safety contracts", () => {
  it("keeps paper mode away from broker capabilities", () => {
    expect(canUseCapability("PAPER", "SIMULATE_ORDER")).toBe(true);
    expect(canUseCapability("PAPER", "SUBMIT_ORDER")).toBe(false);
    expect(() => assertPaperIsolation("PAPER", "BROKER")).toThrow();
  });

  it("redacts credential-shaped fields recursively", () => {
    expect(redactSecrets({ token: "secret", nested: { password: "hidden", safe: "visible" } })).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]", safe: "visible" } });
  });

  it("treats stale and unknown events as unsafe", () => {
    expect(isUnsafeEvent({ eventId: "1", eventType: "quote.updated", schemaVersion: "1.0", occurredAt: "", receivedAt: "", mode: "SYSTEM", subjectType: "quote", subjectId: "NIFTY", freshness: "STALE", severity: "WARNING", payload: null })).toBe(true);
  });
});