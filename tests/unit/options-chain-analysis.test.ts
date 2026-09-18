import { describe, expect, it } from "vitest";
import { classifyOiChange, summarizeOptions } from "../../services/options-analytics/src/options-chain-service";

describe("options-chain analysis", () => {
  it("classifies OI build-up with price evidence", () => {
    expect(classifyOiChange({ priceChange: 4, oiChange: 20, volume: 100 }).classification).toBe("LONG_BUILD_UP");
    expect(classifyOiChange({ priceChange: -4, oiChange: 20, volume: 100 }).classification).toBe("SHORT_BUILD_UP");
  });
  it("marks missing evidence unknown", () => {
    expect(classifyOiChange({ priceChange: 4, oiChange: undefined, volume: 100 }).classification).toBe("UNKNOWN");
  });
  it("keeps existing options summary compatibility", () => {
    expect(summarizeOptions([{ strike: 100, ltp: 4, oi: 10, oiChange: 2 }], [{ strike: 100, ltp: 3, oi: 20, oiChange: 4 }]).pcr).toBe(2);
  });
});
