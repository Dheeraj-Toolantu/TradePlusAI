export type StrategyReference = { strategyId: string; version: number; immutable: boolean };

export function referenceForStrategy(strategyId: string, version: number, immutable = false): StrategyReference { return { strategyId, version, immutable }; }