import { describe, expect, it } from "vitest";
import { getActiveOrdersFromFirestore, saveOrderToFirestore, updateOrderInFirestore, type OrderRecord } from "../../apps/web/lib/firestore-orders";
import { firestoreFake } from "../setup/firestore-fake";

const LIVE = ["openTrade", "openTrades", "positionTrade", "positionTrades"];
const EXITED = ["ExitedTrade", "exitedTrade", "exitedTrades"];
const order = (id: string, status: OrderRecord["status"] = "OPEN"): OrderRecord => ({ id, symbol: `NIFTY${id}CE`, side: "BUY", quantity: 65, price: 100, status, mode: "PAPER", createdAt: "2026-09-28T04:00:00.000Z" });
const idsIn = (path: string) => firestoreFake.documents(path).map((document) => document.id);

describe("stale live-trade copies", () => {
  it("removes live copies when an exited order is saved", async () => {
    await saveOrderToFirestore(order("A"));
    for (const path of LIVE) expect(idsIn(path)).toEqual(["A"]);
    await saveOrderToFirestore({ ...order("A"), status: "EXITED", exitPrice: 120 });
    for (const path of LIVE) expect(idsIn(path)).toEqual([]);
    for (const path of EXITED) expect(idsIn(path)).toEqual(["A"]);
    expect(firestoreFake.documents("orders")[0]).toMatchObject({ id: "A", status: "EXITED" });
  });

  it("writes exited collections and removes live copies when an order is updated to EXITED", async () => {
    await saveOrderToFirestore(order("B"));
    await updateOrderInFirestore("B", { status: "EXITED", exitPrice: 90, exitReason: "MANUAL_EXIT" });
    for (const path of LIVE) expect(idsIn(path)).toEqual([]);
    for (const path of EXITED) expect(firestoreFake.documents(path)).toEqual([expect.objectContaining({ id: "B", status: "EXITED", exitReason: "MANUAL_EXIT" })]);
  });

  it("keeps simulated suggestions out of the live collections", async () => {
    await saveOrderToFirestore(order("S", "SIMULATED"));
    for (const path of LIVE) expect(idsIn(path)).toEqual([]);
  });

  it("ignores and deletes stale OPEN copies of an order that already exited", async () => {
    firestoreFake.seed("orders", "C", { ...order("C"), status: "EXITED" });
    firestoreFake.seed("ExitedTrade", "C", { ...order("C"), status: "EXITED" });
    for (const path of LIVE) firestoreFake.seed(path, "C", order("C"));
    firestoreFake.seed("openTrade", "D", order("D"));

    const active = await getActiveOrdersFromFirestore();

    expect(active.map((item) => item.id)).toEqual(["D"]);
    for (const path of LIVE) expect(idsIn(path)).not.toContain("C");
    expect(idsIn("openTrade")).toEqual(["D"]);
  });
});
