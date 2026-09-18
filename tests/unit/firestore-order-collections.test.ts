import { describe, expect, it } from "vitest";
import { tradeCollectionsForStatus } from "../../apps/web/lib/firestore-orders";

describe("trade collection routing", () => {
  it("routes open and position records to the live trade collections", () => {
    expect(tradeCollectionsForStatus("OPEN")).toEqual(
      expect.arrayContaining(["orders", "openTrades", "openTrade", "positionTrades", "positionTrade"])
    );
    expect(tradeCollectionsForStatus("FILLED")).toEqual(
      expect.arrayContaining(["orders", "openTrades", "openTrade", "positionTrades", "positionTrade"])
    );
  });

  it("routes exited records to the exited and history collections", () => {
    expect(tradeCollectionsForStatus("EXITED")).toEqual(
      expect.arrayContaining(["orders", "exitedTrades", "ExitedTrade"])
    );
  });
});
