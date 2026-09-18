import { describe, expect, it } from "vitest";
import { NotificationService } from "../../services/notifications/src/notification-service";

describe("notifications", () => { it("routes a critical broker event", () => { const service = new NotificationService(); const notification = service.create({ category: "BROKER_DISCONNECTED", severity: "CRITICAL", mode: "ALGO_LIVE", subjectId: "connection-1", message: "Broker disconnected" }); expect(service.markDelivered(notification.id).deliveryState).toBe("DELIVERED"); }); });