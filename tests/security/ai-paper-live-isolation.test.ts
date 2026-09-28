import { describe, expect, it } from "vitest";
import { assertPaperIsolation } from "../../services/execution/src/mode-policy";

describe("AI paper/live isolation", () => {
  it("allows simulator access but rejects broker access in PAPER mode", () => {
    expect(() => assertPaperIsolation("PAPER", "SIMULATOR")).not.toThrow();
    expect(() => assertPaperIsolation("PAPER", "BROKER")).toThrow("Paper mode cannot access broker endpoints");
  });
});
