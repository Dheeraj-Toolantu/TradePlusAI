import { describe, expect, it } from "vitest";
import { formatMoney } from "../../apps/web/lib/money";

describe("formatMoney", () => {
  it("formats finite numeric values in INR format", () => {
    expect(formatMoney(12345.67)).toBe("12,345.67");
  });

  it("parses string values and strips currency symbols", () => {
    expect(formatMoney("₹1,234.50")).toBe("1,234.5");
  });

  it("returns a safe placeholder when the value is missing", () => {
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney(null)).toBe("—");
  });
});
