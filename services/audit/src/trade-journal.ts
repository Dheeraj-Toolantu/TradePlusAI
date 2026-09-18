export type JournalEntry = { signalId: string; strategyVersion: string; riskDecision: string; orderId?: string; fills: string[]; exit?: string; outcome?: number; rationale: string };

export function projectTradeJournal(input: JournalEntry): JournalEntry {
  if (!input.signalId || !input.strategyVersion || !input.riskDecision) throw new Error("Journal entries require decision trace identifiers");
  return { ...input, fills: [...input.fills] };
}