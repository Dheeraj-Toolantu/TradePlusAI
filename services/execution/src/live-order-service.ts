import type { BrokerAdapter, BrokerOrderRequest, BrokerOrderState } from "../../../packages/broker-contracts/src/broker-adapter";

export type LiveEntryInput = {
  referenceId: string;
  stopReferenceId: string;
  symbol: string;
  quantity: number;
  side: "BUY" | "SELL";
  entryPrice?: number;
  stopLoss: number;
  exchange: "NSE" | "BSE";
  product: "NRML";
};

export type LiveEntryResult = {
  entry: BrokerOrderState;
  protectiveStop: BrokerOrderState;
};

export async function submitLiveEntry(adapter: BrokerAdapter, input: LiveEntryInput): Promise<LiveEntryResult> {
  const entry = await adapter.placeOrder({
    referenceId: input.referenceId,
    symbol: input.symbol,
    quantity: input.quantity,
    side: input.side,
    orderType: input.entryPrice ? "LIMIT" : "MARKET",
    price: input.entryPrice,
    exchange: input.exchange,
    segment: "FNO",
    product: input.product,
  });
  if ("error" in entry) throw new Error(entry.error.message);

  const stopSide = input.side === "BUY" ? "SELL" : "BUY";
  try {
    const protectiveStop = await adapter.placeOrder({
      referenceId: input.stopReferenceId,
      symbol: input.symbol,
      quantity: input.quantity,
      side: stopSide,
      orderType: "SL_M",
      triggerPrice: input.stopLoss,
      exchange: input.exchange,
      segment: "FNO",
      product: input.product,
    });
    if ("error" in protectiveStop) throw new Error(protectiveStop.error.message);
    return { entry: entry.value, protectiveStop: protectiveStop.value };
  } catch (error) {
    try {
      await adapter.cancelOrder(entry.value.brokerOrderId);
    } catch {
      try {
        const emergencyExit = await adapter.placeOrder({ referenceId: `ex-${Date.now()}`, symbol: input.symbol, quantity: input.quantity, side: input.side === "BUY" ? "SELL" : "BUY", orderType: "MARKET", exchange: input.exchange, segment: "FNO", product: input.product });
        if ("error" in emergencyExit) throw new Error(emergencyExit.error.message);
      } catch (exitError) {
        throw new Error(`Protective stop failed and emergency exit failed: ${exitError instanceof Error ? exitError.message : "unknown broker error"}`);
      }
    }
    throw new Error(`Protective stop could not be established: ${error instanceof Error ? error.message : "unknown broker error"}`);
  }
}

export async function exitLivePosition(adapter: BrokerAdapter, input: { referenceId: string; symbol: string; quantity: number; entrySide: "BUY" | "SELL"; exchange: "NSE" | "BSE"; product: "NRML"; protectiveStopOrderId?: string }): Promise<BrokerOrderState> {
  if (input.protectiveStopOrderId) {
    try { await adapter.cancelOrder(input.protectiveStopOrderId); } catch { /* Continue with the market exit and reconcile afterward. */ }
  }
  const exit = await adapter.placeOrder({
    referenceId: input.referenceId,
    symbol: input.symbol,
    quantity: input.quantity,
    side: input.entrySide === "BUY" ? "SELL" : "BUY",
    orderType: "MARKET",
    exchange: input.exchange,
    segment: "FNO",
    product: input.product,
  });
  if ("error" in exit) throw new Error(exit.error.message);
  return exit.value;
}

export async function moveTrailingStop(adapter: BrokerAdapter, input: { referenceId: string; stopOrderId: string; symbol: string; quantity: number; entrySide: "BUY" | "SELL"; stopPrice: number; exchange: "NSE" | "BSE"; product: "NRML" }): Promise<BrokerOrderState> {
  await adapter.cancelOrder(input.stopOrderId);
  const result = await adapter.placeOrder({
    referenceId: input.referenceId,
    symbol: input.symbol,
    quantity: input.quantity,
    side: input.entrySide === "BUY" ? "SELL" : "BUY",
    orderType: "SL_M",
    triggerPrice: input.stopPrice,
    exchange: input.exchange,
    segment: "FNO",
    product: input.product,
  });
  if ("error" in result) throw new Error(result.error.message);
  return result.value;
}
