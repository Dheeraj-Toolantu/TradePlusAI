import type { BrokerOrderRequest } from "../../../packages/broker-contracts/src/broker-adapter";

export function validateReferenceId(referenceId: string): string {
  if (!/^[A-Za-z0-9-]{8,20}$/.test(referenceId) || (referenceId.match(/-/g) ?? []).length > 2) throw new Error("Groww reference ID must be 8-20 alphanumeric characters with at most two hyphens");
  return referenceId;
}

export function toGrowwOrder(request: BrokerOrderRequest) {
  if (!/^[A-Za-z0-9._&-]{1,40}$/.test(request.symbol)) throw new Error("Groww trading symbol is invalid");
  if (!Number.isInteger(request.quantity) || request.quantity <= 0) throw new Error("Groww order quantity must be a positive integer");
  if ((request.orderType === "LIMIT" || request.orderType === "SL") && (!Number.isFinite(request.price) || request.price! <= 0)) throw new Error("A positive price is required for this order type");
  if ((request.orderType === "SL" || request.orderType === "SL_M") && (!Number.isFinite(request.triggerPrice) || request.triggerPrice! <= 0)) throw new Error("A positive trigger price is required for stop orders");
  return { trading_symbol: request.symbol, quantity: request.quantity, price: request.price, trigger_price: request.triggerPrice, validity: "DAY", exchange: request.exchange ?? "NSE", segment: request.segment ?? "FNO", product: request.product ?? (request.segment === "CASH" ? "CNC" : "NRML"), order_type: request.orderType, transaction_type: request.side, order_reference_id: validateReferenceId(request.referenceId) };
}