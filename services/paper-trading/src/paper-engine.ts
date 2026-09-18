import { assertPaperIsolation } from "../../execution/src/mode-policy";
import type { PaperAccount, PaperOrder } from "./paper-repository";

export function simulateOrder(account: PaperAccount, order: Omit<PaperOrder, "id" | "status">): PaperAccount {
  assertPaperIsolation("PAPER", "SIMULATOR");
  const filled: PaperOrder = { ...order, id: crypto.randomUUID(), status: "FILLED" };
  return { ...account, orders: [...account.orders, filled] };
}