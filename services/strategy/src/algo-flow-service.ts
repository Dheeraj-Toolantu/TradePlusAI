import type { AlgoFlowEvaluation, GateResult } from "../../../packages/domain-contracts/src/algo-flow";
import type { AlgoFlowInput, AlgoFlowResult } from "./algo-flow-gate";
import { evaluateAlgoFlow } from "./algo-flow-gate";

export class AlgoFlowService {
  private readonly evaluations: AlgoFlowEvaluation[] = [];
  evaluate(candidateId: string, input: AlgoFlowInput, mode: "PAPER" | "ASSISTED" | "ALGO_LIVE", broker: string): AlgoFlowEvaluation {
    const result: AlgoFlowResult = evaluateAlgoFlow(input);
    const gateResults: GateResult[] = [{ stage: result.stage, observedValue: result.risk ?? input.newsImpact, threshold: result.stage === "NEWS" ? input.minimumNewsImpact : undefined, passed: result.allowed, reason: result.reason, evaluatedAt: new Date().toISOString() }];
    const evaluation: AlgoFlowEvaluation = { id: crypto.randomUUID(), candidateId, correlationId: crypto.randomUUID(), mode, broker, currentStage: result.stage, finalDecision: result.allowed ? "COMPLETED" : "BLOCK", gateResults, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    this.evaluations.push(evaluation);
    return evaluation;
  }
  list() { return [...this.evaluations]; }
}