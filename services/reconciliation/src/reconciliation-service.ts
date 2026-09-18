import type { BrokerAdapter } from "../../../packages/broker-contracts/src/broker-adapter";

export async function reconcileBroker(adapter: BrokerAdapter) {
  const result = await adapter.reconcile();
  if (!result.ok) throw new Error(result.error.message);
  return { ...result.value, automationBlocked: result.value.unexpectedPositions.length > 0 };
}