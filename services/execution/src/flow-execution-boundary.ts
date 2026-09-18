import type { AlgoFlowEvaluation } from "../../../packages/domain-contracts/src/algo-flow";

export function assertExecutionApproved(evaluation: AlgoFlowEvaluation): void {
  if (evaluation.currentStage !== "EXECUTION" || evaluation.finalDecision !== "COMPLETED") throw new Error(`Execution blocked at ${evaluation.currentStage}`);
}