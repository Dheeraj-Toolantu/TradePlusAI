import { afterEach, describe, expect, it } from "vitest";
import { SmartScalper } from "../../services/paper-trading/src/smart-scalper";
import { getScalper } from "../../apps/web/lib/scalper-instance";

const holder = globalThis as typeof globalThis & { __tradepulseScalper?: unknown };

describe("process-wide scalper book after a code update", () => {
  afterEach(() => { delete holder.__tradepulseScalper; });

  it("moves a book created by older code onto the current class and keeps its positions", async () => {
    // A book left over from older code: its modify() did not know the MONEY trailing mode.
    class OldSmartScalper { positions = [{ id: "kept" }]; tradesToday = 2; modify() { return { error: "Unknown trailing mode MONEY." }; } }
    holder.__tradepulseScalper = new OldSmartScalper();
    const book = getScalper() as unknown as SmartScalper & { positions: Array<{ id: string }>; tradesToday: number };
    expect(Object.getPrototypeOf(book)).toBe(SmartScalper.prototype);
    expect(book.positions).toEqual([{ id: "kept" }]);
    expect(book.tradesToday).toBe(2);
    expect(book.modify).toBe(SmartScalper.prototype.modify);
  });

  it("keeps the same book across calls", () => {
    expect(getScalper()).toBe(getScalper());
  });
});
