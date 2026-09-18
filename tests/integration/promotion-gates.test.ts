import { describe, expect, it } from "vitest";
import { nextPromotionState } from "../../services/strategy/src/promotion-gates";

describe("promotion gates", () => { it("requires every validation stage", () => { expect(nextPromotionState({ outOfSample: true, walkForward: true, paperValidated: false, assistedApproved: false, cappedLive: false, consent: false })).toBe("WALK_FORWARD_VALIDATED"); expect(nextPromotionState({ outOfSample: true, walkForward: true, paperValidated: true, assistedApproved: true, cappedLive: true, consent: true })).toBe("ALGO_LIVE_CAPPED"); }); });