export type RuleNode =
  | { type: "AND" | "OR"; children: RuleNode[] }
  | { type: "NOT"; child: RuleNode }
  | { type: "INDICATOR" | "PRICE_ACTION" | "OPTIONS" | "NEWS"; field: string; operator: string; value: number | string | boolean };

export type StrategyDefinition = { instruments: string[]; timeframes: string[]; entry: RuleNode; risk: { riskPercent: number; minimumRiskReward: number }; exits: RuleNode[] };

export function validateRule(node: RuleNode): string[] {
  if ((node.type === "AND" || node.type === "OR") && node.children.length === 0) return [`${node.type} requires at least one child`];
  if (node.type === "NOT") return validateRule(node.child);
  if ("field" in node && (!node.field || !node.operator)) return ["Condition requires a field and operator"];
  if ("children" in node) return node.children.flatMap(validateRule);
  return [];
}

export function validateStrategy(strategy: StrategyDefinition): string[] {
  return [...(strategy.instruments.length ? [] : ["At least one instrument is required"]), ...(strategy.timeframes.length ? [] : ["At least one timeframe is required"]), ...validateRule(strategy.entry), ...(strategy.risk.riskPercent > 0 ? [] : ["Risk percent must be positive"]), ...(strategy.risk.minimumRiskReward > 0 ? [] : ["Minimum R:R must be positive"])];
}