import type { Position, RiskDecision, Signal } from "../../../packages/domain-contracts/src/entities";

export class SignalRepository {
  readonly signals: Signal[] = [];
  readonly decisions: RiskDecision[] = [];
  readonly positions: Position[] = [];
  saveSignal(signal: Signal) { this.signals.push(signal); return signal; }
  saveDecision(decision: RiskDecision) { this.decisions.push(decision); return decision; }
  savePosition(position: Position) { this.positions.push(position); return position; }
}