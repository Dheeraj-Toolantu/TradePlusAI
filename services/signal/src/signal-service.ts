import type { Signal } from "../../../packages/domain-contracts/src/entities";
import { evaluateRisk } from "../../risk/src/risk-gate";
import type { RiskGateInput } from "../../../packages/domain-contracts/src/risk-gate";
import { SignalRepository } from "./signal-repository";

export class SignalService {
  constructor(private readonly repository = new SignalRepository()) {}
  evaluate(signal: Signal, risk: RiskGateInput) { const decision = evaluateRisk(risk); this.repository.saveSignal(signal); this.repository.saveDecision({ id: crypto.randomUUID(), signalId: signal.id, mode: risk.mode, decision: decision.decision, checks: decision.checks, reason: decision.checks.filter((check) => !check.result).map((check) => check.reason).join(" "), evaluatedAt: new Date().toISOString() }); return { signal, decision }; }
}