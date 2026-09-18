import type { BrokerAdapter, BrokerOrderRequest, BrokerOrderState, BrokerPosition, BrokerQuote, BrokerResult } from "../../../packages/broker-contracts/src/broker-adapter";
import { simulateOrder } from "./paper-engine";
import type { PaperAccount } from "./paper-repository";

export class PaperBrokerAdapter implements BrokerAdapter {
  constructor(private account: PaperAccount) {}
  async healthCheck(): Promise<BrokerResult<{ connected: boolean; authenticated: boolean; permissions: string[]; checkedAt: string }>> { return { ok: true, value: { connected: true, authenticated: true, permissions: ["simulate"], checkedAt: new Date().toISOString() } }; }
  async getQuotes(symbols: string[]): Promise<BrokerResult<BrokerQuote[]>> { return { ok: true, value: symbols.map((symbol) => ({ symbol, price: 0, timestamp: new Date().toISOString() })) }; }
  async getPositions(): Promise<BrokerResult<BrokerPosition[]>> { return { ok: true, value: [] }; }
  async placeOrder(request: BrokerOrderRequest): Promise<BrokerResult<BrokerOrderState>> { this.account = simulateOrder(this.account, { symbol: request.symbol, side: request.side, quantity: request.quantity, price: request.price ?? 0 }); return { ok: true, value: { brokerOrderId: `paper-${this.account.orders.at(-1)?.id ?? crypto.randomUUID()}`, status: "FILLED", filledQuantity: request.quantity, remainingQuantity: 0, averageFillPrice: request.price } }; }
  async getOrderStatus(referenceId: string): Promise<BrokerResult<BrokerOrderState>> { return { ok: true, value: { brokerOrderId: referenceId, status: "FILLED", filledQuantity: 0, remainingQuantity: 0 } }; }
  async cancelOrder(orderId: string): Promise<BrokerResult<BrokerOrderState>> { return { ok: true, value: { brokerOrderId: orderId, status: "CANCELLED", filledQuantity: 0, remainingQuantity: 0 } }; }
  async reconcile(): Promise<BrokerResult<{ unexpectedPositions: BrokerPosition[] }>> { return { ok: true, value: { unexpectedPositions: [] } }; }
}