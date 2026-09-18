export type OcoRequest = { referenceId: string; symbol: string; quantity: number; netPositionQuantity: number; targetTrigger: number; stopTrigger: number };

export function toGrowwOco(request: OcoRequest) {
  if (request.quantity <= 0 || request.quantity > Math.abs(request.netPositionQuantity)) throw new Error("OCO quantity must not exceed the absolute net position quantity");
  return { reference_id: request.referenceId, smart_order_type: "OCO", segment: "FNO", trading_symbol: request.symbol, quantity: request.quantity, net_position_quantity: request.netPositionQuantity, transaction_type: request.netPositionQuantity > 0 ? "SELL" : "BUY", target: { trigger_price: request.targetTrigger, order_type: "LIMIT" }, stop_loss: { trigger_price: request.stopTrigger, order_type: "SL_M" }, product_type: "NRML", exchange: "NSE", duration: "DAY" };
}

export function toGrowwProtection(request: OcoRequest) { return toGrowwOco(request); }