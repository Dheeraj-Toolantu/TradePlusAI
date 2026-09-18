import { describe, expect, it } from "vitest";
import { NotificationOutbox } from "../../services/notifications/src/notification-outbox";

describe("notification outbox", () => { it("tracks delivery and correlation", async () => { const outbox = new NotificationOutbox(); const event = outbox.enqueue({ category: "ENTRY", mode: "PAPER", severity: "INFO", subjectId: "s1", message: "entry", correlationId: "c1" }); const delivered = await outbox.deliver(event.id); expect(delivered.deliveryState).toBe("DELIVERED"); expect(delivered.correlationId).toBe("c1"); }); });