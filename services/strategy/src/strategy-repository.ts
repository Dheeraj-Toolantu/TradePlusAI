import type { Strategy } from "../../../packages/domain-contracts/src/entities";

export class StrategyRepository {
  private readonly strategies = new Map<string, Strategy>();
  save(strategy: Strategy) { this.strategies.set(`${strategy.id}:${strategy.version}`, strategy); return strategy; }
  get(id: string, version: number) { return this.strategies.get(`${id}:${version}`); }
}