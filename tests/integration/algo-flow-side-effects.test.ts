import { describe, expect, it } from "vitest";
import { assertExecutionApproved } from "../../services/execution/src/flow-execution-boundary";
import { AlgoFlowService } from "../../services/strategy/src/algo-flow-service";

const input = { newsImpact: 60, minimumNewsImpact: 70, regimeAllowed: true, technicalConfirmed: true, optionsConfirmed: true, liquidityConfirmed: true, risk: { signalId: "s", mode: "PAPER" as const, capital: 100000, riskPercent: 1, entry: 100, stop: 90, target: 120, candidateQuantity: 50, lotSize: 50, dailyLoss: 0, maxDailyLoss: 3000, openPositions: 0, maxOpenPositions: 2, tradesToday: 0, maxTradesToday: 5, minRiskReward: 2, marketFreshness: "FRESH" as const, killSwitch: false } };
describe("flow execution boundary", () => { it("blocks execution for a failed gate", () => { const evaluation = new AlgoFlowService().evaluate("candidate-1", input, "PAPER", "Paper Broker"); expect(() => assertExecutionApproved(evaluation)).toThrow("NEWS"); }); });