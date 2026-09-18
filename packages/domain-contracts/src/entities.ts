import type { Decision, Freshness, Identifier, IsoTimestamp, Mode, Severity } from "./primitives";

export type Instrument = { id: Identifier; exchange: string; symbol: string; segment: "CASH" | "FNO"; expiry?: IsoTimestamp; strike?: number; optionType?: "CE" | "PE"; lotSize: number; status: "ACTIVE" | "UNAVAILABLE" };
export type MarketCandle = { instrumentId: Identifier; timeframe: string; timestamp: IsoTimestamp; open: number; high: number; low: number; close: number; volume: number; quality: Freshness };
export type OptionSnapshot = { instrumentId: Identifier; timestamp: IsoTimestamp; ltp?: number; oi?: number; oiChange?: number; iv?: number; volume?: number; bid?: number; ask?: number; quality: Freshness };
export type Strategy = { id: Identifier; ownerId: Identifier; version: number; rules: unknown; riskConfig: unknown; promotionState: string; immutable: boolean };
export type Signal = { id: Identifier; strategyVersion: string; instrumentId: Identifier; state: string; score: number; rationale: string; riskDecisionId?: Identifier; createdAt: IsoTimestamp };
export type Order = { id: Identifier; mode: Mode; signalId?: Identifier; instrumentId: Identifier; side: "BUY" | "SELL"; quantity: number; internalReference: string; brokerOrderId?: string; status: string; filledQuantity: number; remainingQuantity: number };
export type Position = { id: Identifier; instrumentId: Identifier; quantity: number; averagePrice: number; stop?: number; targets: number[]; state: string };
export type RiskDecision = { id: Identifier; signalId: Identifier; mode: Mode; decision: Decision; checks: Array<{ name: string; observed: unknown; threshold?: unknown; result: boolean; reason: string }>; reason: string; evaluatedAt: IsoTimestamp };
export type AuditEvent = { id: Identifier; actor: string; action: string; objectType: string; objectId: Identifier; reason?: string; occurredAt: IsoTimestamp; before?: unknown; after?: unknown };
export type Notification = { id: Identifier; category: string; severity: Severity; mode: Mode; subjectId: Identifier; message: string; deliveryState: string };