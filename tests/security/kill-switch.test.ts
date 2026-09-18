import { describe, expect, it } from "vitest";
import { KillSwitchService } from "../../services/risk/src/kill-switch-service";

describe("kill switch", () => { it("blocks after activation and recovers explicitly", () => { const service = new KillSwitchService(); service.activate("operator stop"); expect(service.isActive()).toBe(true); service.deactivate(); expect(service.isActive()).toBe(false); }); });