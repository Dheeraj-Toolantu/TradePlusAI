import { describe, expect, it } from "vitest";
import { transitionSignal } from "../../services/signal/src/signal-state-machine";

describe("signal state machine", () => {
  it("progresses through a confirmed entry", () => { expect(transitionSignal("WATCHING", "PRE_ENTRY")).toBe("PRE_ENTRY"); expect(transitionSignal("PRE_ENTRY", "ENTRY_CONFIRMED")).toBe("ENTRY_CONFIRMED"); });
  it("rejects invalid transitions", () => { expect(() => transitionSignal("NO_SETUP", "FILLED")).toThrow(); });
});