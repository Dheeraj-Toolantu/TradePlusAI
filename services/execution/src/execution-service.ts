import type { BrokerAdapter, BrokerOrderRequest, BrokerOrderState } from "../../../packages/broker-contracts/src/broker-adapter";
import { ExecutionRepository } from "./execution-repository";

export class ExecutionService {
  constructor(private readonly broker: BrokerAdapter, private readonly repository = new ExecutionRepository()) {}
  async place(request: BrokerOrderRequest): Promise<BrokerOrderState> {
    const existing = this.repository.get(request.referenceId);
    if (existing?.brokerOrderId) return { brokerOrderId: existing.brokerOrderId, status: existing.status, filledQuantity: 0, remainingQuantity: request.quantity };
    this.repository.save({ internalReference: request.referenceId, status: "CREATED" });
    const result = await this.broker.placeOrder(request);
    if (!result.ok) { this.repository.save({ internalReference: request.referenceId, status: "UNKNOWN" }); throw new Error(result.error.message); }
    this.repository.save({ internalReference: request.referenceId, status: "SUBMITTED", brokerOrderId: result.value.brokerOrderId });
    return result.value;
  }
}