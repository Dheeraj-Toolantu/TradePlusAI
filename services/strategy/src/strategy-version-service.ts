import type { Strategy } from "../../../packages/domain-contracts/src/entities";
import type { StrategyDefinition } from "./strategy-schema";
import { validateStrategy } from "./strategy-schema";

export function createStrategyVersion(previous: Strategy | undefined, definition: StrategyDefinition, ownerId: string): Strategy {
  const errors = validateStrategy(definition);
  if (errors.length) throw new Error(errors.join("; "));
  return { id: previous?.id ?? crypto.randomUUID(), ownerId, version: (previous?.version ?? 0) + 1, rules: definition, riskConfig: definition.risk, promotionState: "DRAFT", immutable: false };
}

export function assertMutable(strategy: Strategy): void { if (strategy.immutable || strategy.promotionState === "ALGO_LIVE_CAPPED") throw new Error("Live strategy versions are immutable"); }