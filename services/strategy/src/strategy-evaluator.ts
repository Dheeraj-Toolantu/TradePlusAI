import type { RuleNode } from "./strategy-schema";

export type EvaluationContext = { values: Record<string, number | string | boolean>; newsCanGate: boolean };

export function evaluateRule(node: RuleNode, context: EvaluationContext): boolean {
  if (node.type === "AND") return node.children.every((child) => evaluateRule(child, context));
  if (node.type === "OR") return node.children.some((child) => evaluateRule(child, context));
  if (node.type === "NOT") return !evaluateRule(node.child, context);
  const actual = context.values[node.field];
  if (node.type === "NEWS" && !context.newsCanGate) return false;
  if (node.operator === ">=") return Number(actual) >= Number(node.value);
  if (node.operator === "<=") return Number(actual) <= Number(node.value);
  if (node.operator === "=") return actual === node.value;
  return false;
}