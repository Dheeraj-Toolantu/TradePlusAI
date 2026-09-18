import type { DomainError, Identifier } from "../../domain-contracts/src/primitives";

export type BrokerHealth = { connected: boolean; authenticated: boolean; permissions: string[]; checkedAt: string };
export type BrokerResult<T> = { ok: true; value: T } | { ok: false; error: DomainError };
export type BrokerOrderRequest = { referenceId: string; symbol: string; quantity: number; side: "BUY" | "SELL"; orderType: "MARKET" | "LIMIT" | "SL" | "SL_M"; price?: number; triggerPrice?: number; exchange?: "NSE" | "BSE"; segment?: "CASH" | "FNO"; product?: "CNC" | "MIS" | "NRML" };
export type BrokerOrderState = { brokerOrderId: string; status: string; filledQuantity: number; remainingQuantity: number; averageFillPrice?: number };
export type BrokerPosition = { symbol: string; quantity: number; averagePrice: number };
export type BrokerQuote = { symbol: string; price: number; change?: number; percent?: number; timestamp: string; open?: number; high?: number; low?: number; volume?: number };

export interface BrokerAdapter {
  healthCheck(): Promise<BrokerResult<BrokerHealth>>;
  getQuotes(symbols: string[]): Promise<BrokerResult<BrokerQuote[]>>;
  getPositions(): Promise<BrokerResult<BrokerPosition[]>>;
  placeOrder(request: BrokerOrderRequest): Promise<BrokerResult<BrokerOrderState>>;
  getOrderStatus(referenceId: string): Promise<BrokerResult<BrokerOrderState>>;
  cancelOrder(orderId: Identifier): Promise<BrokerResult<BrokerOrderState>>;
  reconcile(): Promise<BrokerResult<{ unexpectedPositions: BrokerPosition[] }>>;
}